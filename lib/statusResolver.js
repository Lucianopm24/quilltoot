// lib/statusResolver.js
//
// El Inbox recibe Like/Announce/Delete que referencian un status por su
// activity_uri (una URL, no nuestro UUID interno). Este helper resuelve
// esa URI contra `statuses` (local) o `remote_statuses` (ya cacheado), y
// si no lo tenemos y es de otra instancia, puede ir a buscarlo (necesario
// para Announce: alguien puede boostear un post de una TERCERA instancia
// que nunca vimos antes).

const pool = require('../db/pool');
const { sanitizeHtml } = require('./htmlSanitizer');
const { resolveRemoteActor } = require('./remoteActors');

const ACTIVITY_JSON_ACCEPT = 'application/activity+json, application/ld+json';

/**
 * Busca un status por su activity_uri, primero en local, luego en remoto.
 * @returns {Promise<{row: object, isRemote: boolean} | null>}
 */
async function resolveStatusByUri(activityUri) {
  const local = await pool.query('SELECT * FROM statuses WHERE activity_uri = $1', [activityUri]);
  if (local.rows.length > 0) return { row: local.rows[0], isRemote: false };

  const remote = await pool.query('SELECT * FROM remote_statuses WHERE activity_uri = $1', [activityUri]);
  if (remote.rows.length > 0) return { row: remote.rows[0], isRemote: true };

  return null;
}

/**
 * Guarda (o devuelve si ya existe) un status remoto a partir de su
 * objeto ActivityPub "Note" ya descargado.
 */
async function upsertRemoteStatus(noteObject, authorActorRow) {
  const attachments = Array.isArray(noteObject.attachment)
    ? noteObject.attachment
        .filter((a) => a && a.url)
        .map((a) => ({ url: a.url, type: a.mediaType || 'unknown', description: a.name || null }))
    : [];

  const result = await pool.query(
    `INSERT INTO remote_statuses (author_actor_id, activity_uri, content, content_warning, attachments, visibility, in_reply_to_uri, raw_object_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (activity_uri) DO NOTHING
     RETURNING *`,
    [
      authorActorRow.id,
      noteObject.id,
      sanitizeHtml(noteObject.content || ''),
      noteObject.summary || null,
      JSON.stringify(attachments),
      noteObject.to?.includes('https://www.w3.org/ns/activitystreams#Public') ? 'public' : 'unlisted',
      noteObject.inReplyTo || null,
      noteObject,
    ]
  );

  if (result.rows.length > 0) return result.rows[0];

  // Ya existía (llegó por otro camino mientras tanto) — lo traemos.
  const existing = await pool.query('SELECT * FROM remote_statuses WHERE activity_uri = $1', [noteObject.id]);
  return existing.rows[0];
}

/**
 * Como resolveStatusByUri, pero si no lo tenemos Y es un status remoto,
 * intenta ir a buscarlo por HTTP (GET al activity_uri) y cachearlo.
 * Usado por Announce, donde es normal recibir un boost de un post de una
 * tercera instancia que nunca vimos.
 *
 * Si el fetch falla (instancia caída, post borrado, etc.) devuelve null
 * en vez de tirar el Inbox entero — un boost roto no debería tumbar el
 * procesamiento de actividades válidas.
 */
async function resolveOrFetchStatus(activityUri) {
  const existing = await resolveStatusByUri(activityUri);
  if (existing) return existing;

  try {
    const response = await fetch(activityUri, { headers: { Accept: ACTIVITY_JSON_ACCEPT } });
    if (!response.ok) return null;

    const noteObject = await response.json();
    if (!noteObject || !noteObject.attributedTo) return null;

    const authorUri = typeof noteObject.attributedTo === 'string' ? noteObject.attributedTo : noteObject.attributedTo.id;
    const authorActor = await resolveRemoteActor(authorUri);

    const row = await upsertRemoteStatus(noteObject, authorActor);
    return { row, isRemote: true };
  } catch (err) {
    console.error(`No se pudo resolver el status remoto ${activityUri}:`, err.message);
    return null;
  }
}

module.exports = { resolveStatusByUri, resolveOrFetchStatus, upsertRemoteStatus };