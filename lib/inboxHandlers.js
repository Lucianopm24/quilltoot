// lib/inboxHandlers.js
//
// Un handler por cada tipo de actividad que puede llegar al Inbox. Todos
// reciben la actividad ya parseada (JSON) y el actor remitente YA
// resuelto (fila de remote_actors, con su clave pública verificada por
// routes/inbox.js antes de llegar acá).
//
// Ninguno de estos handlers debería tirar una excepción por actividades
// "raras pero no maliciosas" (un Like a algo que no tenemos, un Undo de
// algo que ya no existe...) — en esos casos, simplemente no hacen nada.
// routes/inbox.js igual envuelve todo en try/catch por si acaso.

const crypto = require('crypto');
const pool = require('../db/pool');
const { resolveStatusByUri, resolveOrFetchStatus, upsertRemoteStatus } = require('./statusResolver');
const { deliverActivity } = require('./activityDelivery');
const { actorUrl } = require('./activitypub');
const { createNotification } = require('./notifications');

function getInstanceDomain() {
  if (!process.env.INSTANCE_DOMAIN) {
    throw new Error('Falta la variable de entorno INSTANCE_DOMAIN.');
  }
  return process.env.INSTANCE_DOMAIN;
}

function getActorUri(value) {
  return typeof value === 'string' ? value : value?.id;
}

/**
 * Dado "https://tudominio.com/users/luciano", extrae "luciano".
 * Devuelve null si la URI no pertenece a esta instancia o no matchea
 * el formato esperado — así los handlers no confunden un actor local
 * con uno remoto que tenga una URL parecida.
 */
function parseLocalUsernameFromActorUri(uri) {
  if (!uri) return null;
  try {
    const url = new URL(uri);
    if (url.hostname !== getInstanceDomain()) return null;
    const match = url.pathname.match(/^\/users\/([^/]+)$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function getLocalUserByUsername(username) {
  if (!username) return null;
  const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  return result.rows[0] || null;
}

/**
 * Follow entrante: alguien de otra instancia nos quiere seguir.
 * Guardamos el follow como 'accepted' (no soportamos cuentas privadas en
 * la V1) y respondemos con un Accept firmado por el usuario seguido.
 */
async function handleFollow(activity, remoteActor) {
  const targetUsername = parseLocalUsernameFromActorUri(getActorUri(activity.object));
  const targetUser = await getLocalUserByUsername(targetUsername);
  if (!targetUser) {
    console.warn(`Follow entrante apunta a un usuario local inexistente: ${activity.object}`);
    return;
  }

  const inserted = await pool.query(
    `INSERT INTO follows (follower_actor_id, followee_user_id, status, follow_activity_uri)
     VALUES ($1, $2, 'accepted', $3)
     ON CONFLICT (follower_actor_id, followee_user_id) DO NOTHING
     RETURNING *`,
    [remoteActor.id, targetUser.id, activity.id]
  );
  if (inserted.rows.length > 0) {
    await pool.query('UPDATE users SET followers_count = followers_count + 1 WHERE id = $1', [targetUser.id]);
    await createNotification({
      recipientUserId: targetUser.id,
      type: 'follow',
      actorActorId: remoteActor.id,
    });
  }

  const instanceDomain = getInstanceDomain();
  const acceptActivity = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${actorUrl(targetUser.username, instanceDomain)}/activities/${crypto.randomUUID()}`,
    type: 'Accept',
    actor: actorUrl(targetUser.username, instanceDomain),
    object: activity,
  };

  await deliverActivity({
    inboxUrl: remoteActor.shared_inbox_url || remoteActor.inbox_url,
    activity: acceptActivity,
    keyId: `${actorUrl(targetUser.username, instanceDomain)}#main-key`,
    privateKeyPem: targetUser.private_key_pem,
  });
}

/**
 * Accept entrante: la instancia remota aceptó un Follow que nosotros
 * mandamos (un usuario local siguiendo a un actor remoto). Pasamos el
 * follow correspondiente de 'pending' a 'accepted'.
 *
 * No dependemos de que follows.follow_activity_uri esté seteado (el
 * módulo 6, que manda el Follow real, todavía no existe): matcheamos
 * por el par (usuario local que sigue, actor remoto seguido), que es
 * justo lo que trae embebido el Follow original dentro del Accept.
 */
async function handleAccept(activity) {
  const innerFollow = activity.object;
  if (!innerFollow || innerFollow.type !== 'Follow') return; // solo nos importa Accept de Follow

  const followerUsername = parseLocalUsernameFromActorUri(getActorUri(innerFollow.actor));
  const followerUser = await getLocalUserByUsername(followerUsername);
  if (!followerUser) return;

  const followeeActorUri = getActorUri(activity.actor);
  const followeeActor = await pool.query('SELECT * FROM remote_actors WHERE actor_uri = $1', [followeeActorUri]);
  if (followeeActor.rows.length === 0) return;

  await pool.query(
    `UPDATE follows SET status = 'accepted'
     WHERE follower_user_id = $1 AND followee_actor_id = $2 AND status = 'pending'`,
    [followerUser.id, followeeActor.rows[0].id]
  );
}

/**
 * Undo: puede deshacer un Follow, un Like o un Announce. El objeto
 * embebido (activity.object) es la actividad original que se deshace.
 */
async function handleUndo(activity, remoteActor) {
  const inner = activity.object;
  if (!inner || typeof inner !== 'object') return;

  if (inner.type === 'Follow') {
    const targetUsername = parseLocalUsernameFromActorUri(getActorUri(inner.object));
    const targetUser = await getLocalUserByUsername(targetUsername);
    if (!targetUser) return;

    const deleted = await pool.query(
      `DELETE FROM follows WHERE follower_actor_id = $1 AND followee_user_id = $2 RETURNING *`,
      [remoteActor.id, targetUser.id]
    );
    if (deleted.rows.length > 0) {
      await pool.query('UPDATE users SET followers_count = GREATEST(followers_count - 1, 0) WHERE id = $1', [targetUser.id]);
    }
    return;
  }

  if (inner.type === 'Like') {
    const statusUri = getActorUri(inner.object) || inner.object;
    const resolved = await resolveStatusByUri(statusUri);
    if (!resolved) return;
    const col = resolved.isRemote ? 'remote_status_id' : 'status_id';
    await pool.query(`DELETE FROM favourites WHERE actor_id = $1 AND ${col} = $2`, [remoteActor.id, resolved.row.id]);
    return;
  }

  if (inner.type === 'Announce') {
    const statusUri = getActorUri(inner.object) || inner.object;
    const resolved = await resolveStatusByUri(statusUri);
    if (!resolved) return;
    const col = resolved.isRemote ? 'remote_status_id' : 'status_id';
    await pool.query(`DELETE FROM reblogs WHERE actor_id = $1 AND ${col} = $2`, [remoteActor.id, resolved.row.id]);
  }
}

/**
 * Create: alguien remoto publicó una Note. La guardamos en
 * remote_statuses. Si es una respuesta a un status que no conocemos
 * todavía (inReplyTo), no la resolvemos activamente acá — solo
 * guardamos la URI; Announce sí resuelve activamente (ver handleAnnounce)
 * porque ahí el objeto en cuestión es justamente lo que alguien nos está
 * mostrando de forma explícita.
 */
async function handleCreate(activity, remoteActor) {
  const note = activity.object;
  if (!note || typeof note !== 'object' || note.type !== 'Note') return;
  if (!note.id || !note.attributedTo) return;

  await upsertRemoteStatus(note, remoteActor);
}

/**
 * Like: alguien remoto favoriteó un status (nuestro, o uno remoto que
 * ya tengamos cacheado).
 */
async function handleLike(activity, remoteActor) {
  const statusUri = typeof activity.object === 'string' ? activity.object : activity.object?.id;
  if (!statusUri) return;

  const resolved = await resolveStatusByUri(statusUri);
  if (!resolved) return; // no es algo que conozcamos ni nos concierna

  const col = resolved.isRemote ? 'remote_status_id' : 'status_id';
  await pool.query(
    `INSERT INTO favourites (actor_id, ${col}) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [remoteActor.id, resolved.row.id]
  );

  if (!resolved.isRemote) {
    await createNotification({
      recipientUserId: resolved.row.author_id,
      type: 'favourite',
      actorActorId: remoteActor.id,
      statusId: resolved.row.id,
    });
  }
}

/**
 * Announce (boost): alguien remoto bosteó un status. A diferencia de
 * Like, acá sí vale la pena ir a buscar el status si no lo tenemos —
 * es normal recibir el boost de un post de una TERCERA instancia que
 * nunca vimos antes de este Announce.
 */
async function handleAnnounce(activity, remoteActor) {
  const statusUri = typeof activity.object === 'string' ? activity.object : activity.object?.id;
  if (!statusUri || !activity.id) return;

  const resolved = await resolveOrFetchStatus(statusUri);
  if (!resolved) return;

  const col = resolved.isRemote ? 'remote_status_id' : 'status_id';
  await pool.query(
    `INSERT INTO reblogs (actor_id, ${col}, activity_uri) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [remoteActor.id, resolved.row.id, activity.id]
  );

  if (!resolved.isRemote) {
    await createNotification({
      recipientUserId: resolved.row.author_id,
      type: 'reblog',
      actorActorId: remoteActor.id,
      statusId: resolved.row.id,
    });
  }
}

/**
 * Delete: el autor original borró su post. Solo borramos si el actor
 * que manda el Delete es efectivamente el autor cacheado del status
 * (para que nadie pueda borrar posts ajenos mandando un Delete falso).
 */
async function handleDelete(activity, remoteActor) {
  const objectUri = typeof activity.object === 'string' ? activity.object : activity.object?.id;
  if (!objectUri) return;

  await pool.query(
    'DELETE FROM remote_statuses WHERE activity_uri = $1 AND author_actor_id = $2',
    [objectUri, remoteActor.id]
  );
}

/**
 * Despacha una actividad ya autenticada al handler correspondiente.
 * Devuelve true si supimos qué hacer con ella (aunque no haya requerido
 * ninguna acción, ej: un Like a algo que no tenemos), false si el tipo
 * de actividad no está soportado (lo registramos igual en inbox_log,
 * simplemente no hacemos nada con ella).
 */
async function dispatchActivity(activity, remoteActor) {
  switch (activity.type) {
    case 'Follow':
      await handleFollow(activity, remoteActor);
      return true;
    case 'Accept':
      await handleAccept(activity, remoteActor);
      return true;
    case 'Undo':
      await handleUndo(activity, remoteActor);
      return true;
    case 'Create':
      await handleCreate(activity, remoteActor);
      return true;
    case 'Like':
      await handleLike(activity, remoteActor);
      return true;
    case 'Announce':
      await handleAnnounce(activity, remoteActor);
      return true;
    case 'Delete':
      await handleDelete(activity, remoteActor);
      return true;
    default:
      return false;
  }
}

module.exports = { dispatchActivity };