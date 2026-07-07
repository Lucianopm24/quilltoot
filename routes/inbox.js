// routes/inbox.js
//
// POST /users/:username/inbox (inbox por usuario) y POST /inbox (shared
// inbox, que varias instancias usan para no mandar la misma actividad
// una vez por cada uno de nuestros usuarios que siguen a alguien ahí).
// Ambos terminan en el mismo procesamiento: nos da igual a cuál de los
// dos haya llegado la actividad, porque el "destinatario" real siempre
// está descrito dentro de la actividad misma (Follow.object, Like.object...).
//
// Flujo:
//   1. Parsear el body (guardando el string crudo, necesario para el Digest).
//   2. Deduplicar contra inbox_log por activity_uri (mismos reintentos que
//      manda cualquier servidor ActivityPub si no respondemos rápido).
//   3. Resolver al actor remitente (por el keyId de la firma) y verificar
//      la firma HTTP contra su clave pública.
//   4. Despachar la actividad ya autenticada al handler correspondiente.
//
// Nunca dejamos que una actividad individual mal formada tumbe el
// servidor — errores de un handler se registran en inbox_log.error y
// respondemos 202 igual, porque el problema es nuestro/de esa actividad,
// no algo que el remitente deba seguir reintentando.

const express = require('express');
const pool = require('../db/pool');
const { verifySignature } = require('../lib/httpSignature');
const { resolveRemoteActor } = require('../lib/remoteActors');
const { dispatchActivity } = require('../lib/inboxHandlers');
const { shouldRejectInbound } = require('../lib/moderation');

const router = express.Router();

// express.json() propio (no dependemos de que index.js monte uno global)
// que además guarda el body crudo en req.rawBody, imprescindible para
// validar el header Digest tal como lo firmó el remitente.
const jsonWithRawBody = express.json({
  type: ['application/activity+json', 'application/ld+json', 'application/json'],
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  },
});

function extractKeyId(signatureHeader) {
  const match = /keyId="([^"]*)"/.exec(signatureHeader || '');
  return match ? match[1] : null;
}

function getActorUri(activity) {
  return typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
}

/**
 * Verifica la firma de la petición contra el actor remitente, con un
 * reintento forzando refresco de la clave pública (por si rotó desde la
 * última vez que la cacheamos).
 */
async function verifyRequestSignature(req) {
  const signatureHeader = req.headers['signature'];
  const keyId = extractKeyId(signatureHeader);
  if (!keyId) return { valid: false, reason: 'No hay keyId en el header Signature.' };

  const actorUri = keyId.split('#')[0];

  let remoteActor;
  try {
    remoteActor = await resolveRemoteActor(actorUri);
  } catch (err) {
    return { valid: false, reason: `No se pudo resolver el actor firmante: ${err.message}` };
  }

  const baseArgs = {
    method: req.method,
    path: req.originalUrl,
    headers: req.headers,
    rawBody: req.rawBody,
  };

  let result = verifySignature({ ...baseArgs, publicKeyPem: remoteActor.public_key_pem });
  if (result.valid) return { valid: true, remoteActor };

  // Puede que la clave haya rotado desde la última vez que la cacheamos.
  try {
    remoteActor = await resolveRemoteActor(actorUri, { forceRefresh: true });
  } catch {
    return result; // el fallo original es el que reportamos
  }
  result = verifySignature({ ...baseArgs, publicKeyPem: remoteActor.public_key_pem });
  return result.valid ? { valid: true, remoteActor } : result;
}

async function handleInboxRequest(req, res) {
  const activity = req.body;

  if (!activity || typeof activity !== 'object' || !activity.id || !activity.type || !activity.actor) {
    return res.status(400).json({ error: 'Actividad mal formada: faltan id, type o actor.' });
  }

  // Deduplicar ANTES de gastar una verificación de firma / posible fetch
  // de actor: los servidores ActivityPub reintentan agresivamente.
  const already = await pool.query('SELECT 1 FROM inbox_log WHERE activity_uri = $1', [activity.id]);
  if (already.rows.length > 0) {
    return res.status(202).json({ status: 'ya procesada' });
  }

  const verification = await verifyRequestSignature(req);
  if (!verification.valid) {
    console.warn(`Firma inválida en Inbox (${activity.type} de ${getActorUri(activity)}): ${verification.reason}`);
    return res.status(401).json({ error: 'Firma HTTP inválida.' });
  }

  // Moderación: un actor o dominio en estado 'suspend' se rechaza acá
  // mismo, ANTES de tocar inbox_log — no queremos ni rastro de sus
  // actividades. No le devolvemos ningún detalle (202 igual), para no
  // confirmarle que lo bloqueamos; solo queda el warning en nuestro log.
  const moderationCheck = await shouldRejectInbound(verification.remoteActor);
  if (moderationCheck.reject) {
    console.warn(`Actividad rechazada por moderación (${activity.type} de ${getActorUri(activity)}): ${moderationCheck.reason}`);
    return res.status(202).json({ status: 'aceptada' });
  }

  // Insertamos el log ANTES de procesar (no después) para que dos
  // reintentos casi simultáneos de la misma actividad no se procesen
  // dos veces: el segundo choca contra el UNIQUE de activity_uri.
  let logged;
  try {
    logged = await pool.query(
      `INSERT INTO inbox_log (activity_uri, activity_type, actor_uri, raw_json)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (activity_uri) DO NOTHING
       RETURNING id`,
      [activity.id, activity.type, getActorUri(activity), activity]
    );
  } catch (err) {
    console.error('Error al registrar actividad en inbox_log:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }

  if (logged.rows.length === 0) {
    // Perdió la carrera contra otro request concurrente para la misma actividad.
    return res.status(202).json({ status: 'ya procesada' });
  }

  try {
    const handled = await dispatchActivity(activity, verification.remoteActor);
    await pool.query(
      'UPDATE inbox_log SET processed = $1 WHERE activity_uri = $2',
      [handled, activity.id]
    );
  } catch (err) {
    console.error(`Error procesando actividad ${activity.type} (${activity.id}):`, err);
    await pool.query('UPDATE inbox_log SET error = $1 WHERE activity_uri = $2', [err.message, activity.id]);
  }

  // 202: la aceptamos para procesar, independientemente de si el handler
  // tuvo éxito — reintentar no va a arreglar un bug de nuestro lado, y
  // el remitente no tiene por qué enterarse de nuestros errores internos.
  return res.status(202).json({ status: 'aceptada' });
}

router.post('/users/:username/inbox', jsonWithRawBody, handleInboxRequest);
router.post('/inbox', jsonWithRawBody, handleInboxRequest);

module.exports = router;