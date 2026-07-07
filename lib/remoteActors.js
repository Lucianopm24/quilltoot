// lib/remoteActors.js
//
// Resuelve el documento Actor de otra instancia a partir de su URI
// (ej: "https://mastodon.social/users/fulano") y lo cachea en
// `remote_actors`, para no tener que pedirlo por HTTP en cada actividad
// que llega de la misma persona.
//
// Usado por el Inbox (módulo 5) para saber quién nos está mandando una
// actividad y con qué clave pública verificarla, y lo reutilizará el
// Outbox (módulo 6) para saber a qué inbox mandar nuestras actividades.

const pool = require('../db/pool');

const ACTIVITY_JSON_ACCEPT = 'application/activity+json, application/ld+json';

// Si el cache tiene más de esto, lo refrescamos igual antes de confiar
// en la clave pública (rotación de claves, cambios de inbox, etc.)
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas

/**
 * Trae el documento Actor por HTTP desde el servidor de origen.
 */
async function fetchActorDocument(actorUri) {
  const response = await fetch(actorUri, {
    headers: { Accept: ACTIVITY_JSON_ACCEPT },
  });
  if (!response.ok) {
    throw new Error(`No se pudo resolver el actor remoto (HTTP ${response.status}): ${actorUri}`);
  }
  return response.json();
}

/**
 * Inserta o actualiza un actor remoto en cache a partir del documento
 * Actor ya descargado.
 */
async function upsertRemoteActor(actorUri, actorDoc) {
  const domain = new URL(actorUri).hostname;
  const username = actorDoc.preferredUsername || actorUri.split('/').pop();
  const inboxUrl = actorDoc.inbox;
  const sharedInboxUrl = actorDoc.endpoints?.sharedInbox || null;
  const publicKeyPem = actorDoc.publicKey?.publicKeyPem;

  if (!inboxUrl || !publicKeyPem) {
    throw new Error(`El documento Actor de ${actorUri} no trae inbox o publicKey, no es válido.`);
  }

  const result = await pool.query(
    `INSERT INTO remote_actors (actor_uri, username, domain, display_name, inbox_url, shared_inbox_url, public_key_pem, raw_actor_json, fetched_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
     ON CONFLICT (actor_uri) DO UPDATE SET
       username = EXCLUDED.username,
       domain = EXCLUDED.domain,
       display_name = EXCLUDED.display_name,
       inbox_url = EXCLUDED.inbox_url,
       shared_inbox_url = EXCLUDED.shared_inbox_url,
       public_key_pem = EXCLUDED.public_key_pem,
       raw_actor_json = EXCLUDED.raw_actor_json,
       updated_at = now()
     RETURNING *`,
    [actorUri, username, domain, actorDoc.name || null, inboxUrl, sharedInboxUrl, publicKeyPem, actorDoc]
  );
  return result.rows[0];
}

/**
 * Resuelve un actor remoto por su URI, usando el cache de `remote_actors`
 * si está fresco. Si `forceRefresh` es true (ej: la firma no verificó con
 * la clave cacheada, podría haber rotado), vuelve a pedir el documento
 * aunque el cache esté vigente.
 *
 * @param {string} actorUri
 * @param {object} [opts]
 * @param {boolean} [opts.forceRefresh]
 * @returns {Promise<object>} fila de remote_actors
 */
async function resolveRemoteActor(actorUri, opts = {}) {
  const { forceRefresh = false } = opts;

  if (!forceRefresh) {
    const cached = await pool.query('SELECT * FROM remote_actors WHERE actor_uri = $1', [actorUri]);
    if (cached.rows.length > 0) {
      const row = cached.rows[0];
      const age = Date.now() - new Date(row.updated_at).getTime();
      if (age < CACHE_TTL_MS) {
        return row;
      }
    }
  }

  const actorDoc = await fetchActorDocument(actorUri);
  return upsertRemoteActor(actorUri, actorDoc);
}

module.exports = { resolveRemoteActor, fetchActorDocument, upsertRemoteActor };