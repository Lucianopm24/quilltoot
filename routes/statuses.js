// routes/statuses.js
//
// CRUD de posts locales (solo texto) + favourite/reblog, que pueden
// aplicarse tanto a posts locales como a posts remotos (favoritear o
// boostear algo que vino federado de otra instancia).
//
// Nota importante: crear un status aquí solo lo GUARDA en nuestra base
// de datos y le asigna su activity_uri. Todavía NO lo manda a los
// followers remotos vía ActivityPub — eso lo hace el módulo de
// Outbox/federación (módulo 6), que se engancha después llamando a
// una función que expondremos desde aquí (queueFederation, ver abajo).

const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const { requireAuth, attachUserIfPresent } = require('../lib/authMiddleware');
const { serializeLocalStatus, serializeRemoteStatus } = require('../lib/serializers');
const { createNotification } = require('../lib/notifications');
const { buildNoteObject } = require('../lib/activitypub');

const router = express.Router();

const MAX_CONTENT_LENGTH = 500; // mismo límite clásico de Mastodon

function getInstanceDomain() {
  if (!process.env.INSTANCE_DOMAIN) {
    throw new Error('Falta la variable de entorno INSTANCE_DOMAIN.');
  }
  return process.env.INSTANCE_DOMAIN;
}

/**
 * Punto de enganche para el módulo de federación (Outbox), que todavía
 * no existe. Por ahora es un no-op documentado: cuando construyamos
 * lib/federation.js, este archivo lo importará y llamará de verdad.
 * Dejarlo así evita que statuses.js tenga que reescribirse cuando
 * lleguemos al módulo 6.
 */
let federationHook = null;
function setFederationHook(fn) {
  federationHook = fn;
}
async function queueFederation(event, payload) {
  if (federationHook) {
    try {
      await federationHook(event, payload);
    } catch (err) {
      console.error(`Error federando evento "${event}":`, err);
    }
  }
}

/**
 * Trae los conteos de favourites/reblogs de un status local, y si hay
 * usuario autenticado, si ESE usuario ya lo favoriteó/reblogueó.
 */
async function getStatusExtras(statusId, isRemote, authUserId) {
  const col = isRemote ? 'remote_status_id' : 'status_id';

  const [favCount, reblogCount, myFav, myReblog] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS c FROM favourites WHERE ${col} = $1`, [statusId]),
    pool.query(`SELECT COUNT(*)::int AS c FROM reblogs WHERE ${col} = $1`, [statusId]),
    authUserId
      ? pool.query(`SELECT 1 FROM favourites WHERE ${col} = $1 AND user_id = $2`, [statusId, authUserId])
      : Promise.resolve({ rows: [] }),
    authUserId
      ? pool.query(`SELECT 1 FROM reblogs WHERE ${col} = $1 AND user_id = $2`, [statusId, authUserId])
      : Promise.resolve({ rows: [] }),
  ]);

  return {
    favourites_count: favCount.rows[0].c,
    reblogs_count: reblogCount.rows[0].c,
    favourited: myFav.rows.length > 0,
    reblogged: myReblog.rows.length > 0,
  };
}

/**
 * POST /api/v1/statuses
 * body: { status, in_reply_to_id?, visibility?, spoiler_text? }
 *
 * Crea un post nuevo. Solo texto — Quilltoot no acepta adjuntos en la V1,
 * así que si el cliente manda `media_ids` (Elk podría intentarlo si el
 * usuario arrastra una imagen), lo rechazamos con un mensaje claro en
 * vez de ignorarlo silenciosamente.
 */
router.post('/api/v1/statuses', requireAuth, async (req, res) => {
  const { status, in_reply_to_id, visibility, spoiler_text, media_ids } = req.body || {};

  if (media_ids && media_ids.length > 0) {
    return res.status(422).json({
      error: 'Esta instancia no soporta adjuntar imágenes ni otros medios en publicaciones propias.',
    });
  }
  if (!status || !status.trim()) {
    return res.status(422).json({ error: 'El campo status no puede estar vacío.' });
  }
  if (status.length > MAX_CONTENT_LENGTH) {
    return res.status(422).json({ error: `El status no puede superar ${MAX_CONTENT_LENGTH} caracteres.` });
  }

  const allowedVisibility = ['public', 'unlisted', 'private', 'direct'];
  const finalVisibility = allowedVisibility.includes(visibility) ? visibility : 'public';

  try {
    const id = crypto.randomUUID();
    const instanceDomain = getInstanceDomain();
    const activityUri = `https://${instanceDomain}/statuses/${id}`;

    // in_reply_to_id puede ser un status local o remoto; averiguamos cuál es.
    let inReplyToStatusId = null;
    let inReplyToRemoteId = null;
    if (in_reply_to_id) {
      const localCheck = await pool.query('SELECT id FROM statuses WHERE id = $1', [in_reply_to_id]);
      if (localCheck.rows.length > 0) {
        inReplyToStatusId = in_reply_to_id;
      } else {
        const remoteCheck = await pool.query('SELECT id FROM remote_statuses WHERE id = $1', [in_reply_to_id]);
        if (remoteCheck.rows.length > 0) inReplyToRemoteId = in_reply_to_id;
      }
    }

    const result = await pool.query(
      `INSERT INTO statuses (id, author_id, content, content_warning, visibility, in_reply_to_status_id, in_reply_to_remote_id, activity_uri)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [id, req.authUser.id, status.trim(), spoiler_text || null, finalVisibility, inReplyToStatusId, inReplyToRemoteId, activityUri]
    );
    const newStatus = result.rows[0];

    await pool.query('UPDATE users SET statuses_count = statuses_count + 1 WHERE id = $1', [req.authUser.id]);

    // Encolar el envío a followers remotos (lo hará de verdad el módulo 6).
    await queueFederation('create', { status: newStatus, author: req.authUser });

    // Notificar al autor del post original si esto es una respuesta a un
    // status LOCAL suyo (a un status remoto no le mandamos notificación:
    // esa la genera el servidor de origen cuando reciba nuestra Reply).
    if (inReplyToStatusId) {
      const parent = await pool.query('SELECT author_id FROM statuses WHERE id = $1', [inReplyToStatusId]);
      if (parent.rows.length > 0) {
        await createNotification({
          recipientUserId: parent.rows[0].author_id,
          type: 'reply',
          actorUserId: req.authUser.id,
          statusId: newStatus.id,
        });
      }
    }

    const extras = await getStatusExtras(newStatus.id, false, req.authUser.id);
    return res.status(200).json(serializeLocalStatus(newStatus, req.authUser, instanceDomain, extras));
  } catch (err) {
    console.error('Error en POST /api/v1/statuses:', err);
    return res.status(500).json({ error: 'Error interno al crear el status.' });
  }
});

/**
 * GET /statuses/:id
 *
 * Esta es la URI PÚBLICA de ActivityPub que nosotros mismos generamos
 * como activity_uri al crear cada status (https://tudominio/statuses/id)
 * y mandamos a los followers remotos en cada Create. Sin esta ruta, esa
 * URL no resolvía a nada — cualquiera que la abriera (un cliente, otra
 * instancia verificando el objeto, o Elk siguiendo el campo "url" del
 * status) se encontraba con el 404 genérico de Express.
 *
 * Solo cubre statuses LOCALES: los remotos no tienen una URI nuestra,
 * viven bajo el dominio de su propia instancia.
 */
router.get('/statuses/:id', async (req, res) => {
  const instanceDomain = getInstanceDomain();
  try {
    const result = await pool.query(
      'SELECT * FROM statuses WHERE id = $1',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Status no encontrado.' });
    }
    const status = result.rows[0];

    if (status.visibility === 'direct' || status.visibility === 'private') {
      // No exponemos DMs ni posts "solo seguidores" en la URI pública.
      return res.status(404).json({ error: 'Status no encontrado.' });
    }

    const author = await pool.query('SELECT * FROM users WHERE id = $1', [status.author_id]);
    if (author.rows.length === 0) {
      return res.status(404).json({ error: 'Status no encontrado.' });
    }

    // Resolver la URI del padre (local o remoto) para inReplyTo.
    let inReplyToUri = null;
    if (status.in_reply_to_status_id) {
      const parent = await pool.query('SELECT activity_uri FROM statuses WHERE id = $1', [status.in_reply_to_status_id]);
      inReplyToUri = parent.rows[0]?.activity_uri || null;
    } else if (status.in_reply_to_remote_id) {
      const parent = await pool.query('SELECT activity_uri FROM remote_statuses WHERE id = $1', [status.in_reply_to_remote_id]);
      inReplyToUri = parent.rows[0]?.activity_uri || null;
    }

    const note = buildNoteObject(status, author.rows[0], instanceDomain, { inReplyToUri });
    res.set('Content-Type', 'application/activity+json');
    return res.json(note);
  } catch (err) {
    console.error('Error en GET /statuses/:id:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

/**
 * GET /api/v1/statuses/:id
 * Busca primero en locales, luego en remotos (el id es un UUID en ambas tablas,
 * así que no hay ambigüedad real de colisión práctica).
 */
router.get('/api/v1/statuses/:id', attachUserIfPresent, async (req, res) => {
  const instanceDomain = getInstanceDomain();
  const { id } = req.params;

  try {
    const localResult = await pool.query(
      `SELECT s.*, u.* , s.id AS status_id, u.id AS user_id
       FROM statuses s JOIN users u ON u.id = s.author_id WHERE s.id = $1`,
      [id]
    );
    if (localResult.rows.length > 0) {
      const row = localResult.rows[0];
      const extras = await getStatusExtras(id, false, req.authUser?.id);
      return res.json(serializeLocalStatus({ ...row, id: row.status_id }, { ...row, id: row.user_id }, instanceDomain, extras));
    }

    const remoteResult = await pool.query(
      `SELECT rs.*, ra.*, rs.id AS status_id, ra.id AS actor_id
       FROM remote_statuses rs JOIN remote_actors ra ON ra.id = rs.author_actor_id WHERE rs.id = $1`,
      [id]
    );
    if (remoteResult.rows.length > 0) {
      const row = remoteResult.rows[0];
      const extras = await getStatusExtras(id, true, req.authUser?.id);
      return res.json(serializeRemoteStatus({ ...row, id: row.status_id }, { ...row, id: row.actor_id }, extras));
    }

    return res.status(404).json({ error: 'Status no encontrado.' });
  } catch (err) {
    console.error('Error en GET /api/v1/statuses/:id:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

/**
 * DELETE /api/v1/statuses/:id
 * Solo el autor puede borrar su propio status. Los remotos NO se pueden
 * borrar desde aquí (eso lo controla el servidor de origen; nosotros
 * solo dejaríamos de mostrarlo si llega un Delete federado, ver módulo 5).
 */
router.delete('/api/v1/statuses/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM statuses WHERE id = $1 AND author_id = $2 RETURNING *',
      [req.params.id, req.authUser.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Status no encontrado o no te pertenece.' });
    }

    await pool.query('UPDATE users SET statuses_count = GREATEST(statuses_count - 1, 0) WHERE id = $1', [req.authUser.id]);
    await queueFederation('delete', { status: result.rows[0], author: req.authUser });

    return res.json({}); // Mastodon responde con el status "tombstone", simplificamos a {}
  } catch (err) {
    console.error('Error en DELETE /api/v1/statuses/:id:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

/**
 * Helper compartido por favourite/reblog: resuelve si un id de status
 * es local o remoto, y devuelve la fila + el tipo.
 */
async function resolveStatus(id) {
  const local = await pool.query('SELECT * FROM statuses WHERE id = $1', [id]);
  if (local.rows.length > 0) return { row: local.rows[0], isRemote: false };

  const remote = await pool.query('SELECT * FROM remote_statuses WHERE id = $1', [id]);
  if (remote.rows.length > 0) return { row: remote.rows[0], isRemote: true };

  return null;
}

/**
 * Serializa y responde el status actualizado tras una acción (favourite/reblog).
 * Mastodon siempre responde con el status completo actualizado, no solo un OK.
 */
async function respondWithStatus(req, res, resolved, id) {
  const instanceDomain = getInstanceDomain();
  const extras = await getStatusExtras(id, resolved.isRemote, req.authUser.id);

  if (resolved.isRemote) {
    const actorResult = await pool.query('SELECT * FROM remote_actors WHERE id = $1', [resolved.row.author_actor_id]);
    return res.json(serializeRemoteStatus(resolved.row, actorResult.rows[0], extras));
  } else {
    const authorResult = await pool.query('SELECT * FROM users WHERE id = $1', [resolved.row.author_id]);
    return res.json(serializeLocalStatus(resolved.row, authorResult.rows[0], instanceDomain, extras));
  }
}

/**
 * POST /api/v1/statuses/:id/favourite
 * POST /api/v1/statuses/:id/unfavourite
 */
router.post('/api/v1/statuses/:id/favourite', requireAuth, async (req, res) => {
  const resolved = await resolveStatus(req.params.id);
  if (!resolved) return res.status(404).json({ error: 'Status no encontrado.' });

  const col = resolved.isRemote ? 'remote_status_id' : 'status_id';
  try {
    await pool.query(
      `INSERT INTO favourites (user_id, ${col}) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [req.authUser.id, req.params.id]
    );
    await queueFederation('like', { statusId: req.params.id, isRemote: resolved.isRemote, actor: req.authUser });

    // Solo notificamos si el post es LOCAL (favear un post remoto le
    // manda un Like federado a esa instancia, que es quien avisa allá).
    if (!resolved.isRemote) {
      await createNotification({
        recipientUserId: resolved.row.author_id,
        type: 'favourite',
        actorUserId: req.authUser.id,
        statusId: req.params.id,
      });
    }

    return await respondWithStatus(req, res, resolved, req.params.id);
  } catch (err) {
    console.error('Error en favourite:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

router.post('/api/v1/statuses/:id/unfavourite', requireAuth, async (req, res) => {
  const resolved = await resolveStatus(req.params.id);
  if (!resolved) return res.status(404).json({ error: 'Status no encontrado.' });

  const col = resolved.isRemote ? 'remote_status_id' : 'status_id';
  try {
    await pool.query(`DELETE FROM favourites WHERE user_id = $1 AND ${col} = $2`, [req.authUser.id, req.params.id]);
    await queueFederation('undo_like', { statusId: req.params.id, isRemote: resolved.isRemote, actor: req.authUser });

    return await respondWithStatus(req, res, resolved, req.params.id);
  } catch (err) {
    console.error('Error en unfavourite:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

/**
 * POST /api/v1/statuses/:id/reblog
 * POST /api/v1/statuses/:id/unreblog
 */
router.post('/api/v1/statuses/:id/reblog', requireAuth, async (req, res) => {
  const resolved = await resolveStatus(req.params.id);
  if (!resolved) return res.status(404).json({ error: 'Status no encontrado.' });

  const col = resolved.isRemote ? 'remote_status_id' : 'status_id';
  const instanceDomain = getInstanceDomain();

  try {
    const activityUri = `https://${instanceDomain}/activities/${crypto.randomUUID()}`;
    await pool.query(
      `INSERT INTO reblogs (user_id, ${col}, activity_uri) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [req.authUser.id, req.params.id, activityUri]
    );
    await queueFederation('announce', { statusId: req.params.id, isRemote: resolved.isRemote, actor: req.authUser, activityUri });

    if (!resolved.isRemote) {
      await createNotification({
        recipientUserId: resolved.row.author_id,
        type: 'reblog',
        actorUserId: req.authUser.id,
        statusId: req.params.id,
      });
    }

    return await respondWithStatus(req, res, resolved, req.params.id);
  } catch (err) {
    console.error('Error en reblog:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

router.post('/api/v1/statuses/:id/unreblog', requireAuth, async (req, res) => {
  const resolved = await resolveStatus(req.params.id);
  if (!resolved) return res.status(404).json({ error: 'Status no encontrado.' });

  const col = resolved.isRemote ? 'remote_status_id' : 'status_id';
  try {
    await pool.query(`DELETE FROM reblogs WHERE user_id = $1 AND ${col} = $2`, [req.authUser.id, req.params.id]);
    await queueFederation('undo_announce', { statusId: req.params.id, isRemote: resolved.isRemote, actor: req.authUser });

    return await respondWithStatus(req, res, resolved, req.params.id);
  } catch (err) {
    console.error('Error en unreblog:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

module.exports = { router, setFederationHook };