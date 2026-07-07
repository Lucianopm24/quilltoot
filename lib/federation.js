// lib/federation.js
//
// Este es el lado de ENVÍO de ActivityPub (Outbox). routes/statuses.js y
// routes/follows.js ya tienen sus queueFederation(event, payload) listos
// desde los módulos anteriores, pero como no-ops documentados — este
// archivo es lo que los vuelve reales, conectándolos con deliverActivity()
// (módulo 5) para firmar y mandar cada actividad al inbox correspondiente.
//
// No expone rutas HTTP. index.js solo necesita llamar a initFederation()
// una vez al arrancar, ANTES de aceptar tráfico, para que las acciones
// de los usuarios (postear, seguir, favoritear, rebloguear) empiecen a
// federar de verdad en vez de quedar solo en la base de datos local.
//
// Nota de diseño: req.authUser (el que llega en los payloads como
// `author`/`actor`/`follower`) NUNCA trae private_key_pem — authMiddleware
// lo excluye a propósito de ese SELECT. Por eso cada handler acá vuelve a
// buscar el usuario completo por id antes de firmar nada.

const pool = require('../db/pool');
const { actorUrl, buildNoteObject, wrapActivity, newActivityUri } = require('./activitypub');
const { deliverActivity } = require('./activityDelivery');
const { setFederationHook: setStatusesHook } = require('../routes/statuses');
const { setFederationHook: setFollowsHook } = require('../routes/follows');

function getInstanceDomain() {
  if (!process.env.INSTANCE_DOMAIN) {
    throw new Error('Falta la variable de entorno INSTANCE_DOMAIN.');
  }
  return process.env.INSTANCE_DOMAIN;
}

async function getFullUser(userId) {
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  if (result.rows.length === 0) {
    throw new Error(`Usuario local ${userId} no encontrado al intentar federar.`);
  }
  return result.rows[0];
}

/**
 * Inboxes de los followers REMOTOS de un usuario local, deduplicados.
 * Preferimos shared_inbox_url sobre inbox_url cuando el servidor remoto
 * lo soporta, para no mandar la misma actividad una vez por cada
 * follower que tengamos ahí (ej: 5 followers en mastodon.social deberían
 * significar 1 sola entrega a su shared inbox, no 5).
 */
async function getFollowerInboxUrls(localUserId) {
  const result = await pool.query(
    `SELECT ra.inbox_url, ra.shared_inbox_url FROM follows f
     JOIN remote_actors ra ON ra.id = f.follower_actor_id
     WHERE f.followee_user_id = $1 AND f.status = 'accepted'`,
    [localUserId]
  );
  const urls = result.rows.map((r) => r.shared_inbox_url || r.inbox_url);
  return [...new Set(urls)];
}

/**
 * Entrega una actividad a varios inboxes en paralelo. Un inbox caído o
 * que responda error NO debe frenar la entrega a los demás — cada intento
 * atrapa su propio error y solo lo loguea.
 */
async function deliverToMany(inboxUrls, activity, keyId, privateKeyPem) {
  await Promise.all(
    inboxUrls.map((inboxUrl) =>
      deliverActivity({ inboxUrl, activity, keyId, privateKeyPem }).catch((err) => {
        console.error(`Error entregando ${activity.type} (${activity.id}) a ${inboxUrl}:`, err.message);
      })
    )
  );
}

// ------------------------------------------------------------
// CREATE — publicar un status nuevo hacia los followers remotos
// ------------------------------------------------------------
async function handleCreate({ status, author: authorStub }) {
  if (status.visibility === 'direct') {
    // Un direct message federado requiere resolver destinatarios por
    // mención (@fulano@instancia dentro del texto), que Quilltoot todavía
    // no parsea. Mejor no mandar nada a que se lo mandemos a quien no
    // corresponde.
    console.warn(`Status ${status.id} es 'direct'; no se federa (sin resolución de menciones aún).`);
    return;
  }

  const instanceDomain = getInstanceDomain();
  const author = await getFullUser(authorStub.id);
  const actorId = actorUrl(author.username, instanceDomain);

  const recipients = new Set(await getFollowerInboxUrls(author.id));

  // Si es una respuesta a un status remoto, avisamos también a su autor
  // directamente — si no, alguien que no nos sigue nunca se enteraría de
  // que le respondimos.
  let inReplyToUri = null;
  if (status.in_reply_to_remote_id) {
    const parent = await pool.query(
      `SELECT rs.activity_uri, ra.inbox_url, ra.shared_inbox_url FROM remote_statuses rs
       JOIN remote_actors ra ON ra.id = rs.author_actor_id WHERE rs.id = $1`,
      [status.in_reply_to_remote_id]
    );
    if (parent.rows.length > 0) {
      inReplyToUri = parent.rows[0].activity_uri;
      recipients.add(parent.rows[0].shared_inbox_url || parent.rows[0].inbox_url);
    }
  }

  const note = buildNoteObject(status, author, instanceDomain, { inReplyToUri });
  const activity = wrapActivity('Create', newActivityUri(instanceDomain), actorId, note);

  await deliverToMany([...recipients], activity, `${actorId}#main-key`, author.private_key_pem);
}

// ------------------------------------------------------------
// DELETE — avisar que borramos un status
// ------------------------------------------------------------
async function handleDelete({ status, author: authorStub }) {
  const instanceDomain = getInstanceDomain();
  const author = await getFullUser(authorStub.id);
  const actorId = actorUrl(author.username, instanceDomain);

  const tombstone = { id: status.activity_uri, type: 'Tombstone', formerType: 'Note' };
  const activity = wrapActivity('Delete', newActivityUri(instanceDomain), actorId, tombstone);

  const recipients = await getFollowerInboxUrls(author.id);
  await deliverToMany(recipients, activity, `${actorId}#main-key`, author.private_key_pem);
}

/**
 * Si el status favoriteado/reblogueado es remoto, trae su activity_uri y
 * el inbox de su autor (a quien hay que avisarle el Like/Announce). Si es
 * local, no hay nadie remoto a quien avisar por esta vía.
 */
async function resolveRemoteStatusTarget(statusId, isRemote) {
  if (!isRemote) {
    const local = await pool.query('SELECT activity_uri FROM statuses WHERE id = $1', [statusId]);
    return local.rows[0] ? { activity_uri: local.rows[0].activity_uri, inbox_url: null, shared_inbox_url: null } : null;
  }
  const remote = await pool.query(
    `SELECT rs.activity_uri, ra.inbox_url, ra.shared_inbox_url FROM remote_statuses rs
     JOIN remote_actors ra ON ra.id = rs.author_actor_id WHERE rs.id = $1`,
    [statusId]
  );
  return remote.rows[0] || null;
}

// ------------------------------------------------------------
// LIKE / UNDO LIKE — solo le concierne al autor del status, no a
// nuestros propios followers (a diferencia de un boost, un like no
// aparece en el timeline de quienes nos siguen).
// ------------------------------------------------------------
async function handleLike({ statusId, isRemote, actor: actorStub }) {
  const target = await resolveRemoteStatusTarget(statusId, isRemote);
  if (!target || !target.inbox_url) return; // status local: nada que federar hacia afuera

  const instanceDomain = getInstanceDomain();
  const actorRow = await getFullUser(actorStub.id);
  const actorId = actorUrl(actorRow.username, instanceDomain);

  const activity = wrapActivity('Like', newActivityUri(instanceDomain), actorId, target.activity_uri);
  await deliverActivity({
    inboxUrl: target.shared_inbox_url || target.inbox_url,
    activity,
    keyId: `${actorId}#main-key`,
    privateKeyPem: actorRow.private_key_pem,
  });
}

async function handleUndoLike({ statusId, isRemote, actor: actorStub }) {
  const target = await resolveRemoteStatusTarget(statusId, isRemote);
  if (!target || !target.inbox_url) return;

  const instanceDomain = getInstanceDomain();
  const actorRow = await getFullUser(actorStub.id);
  const actorId = actorUrl(actorRow.username, instanceDomain);

  // No guardamos el id del Like original (favourites no tiene activity_uri),
  // así que reconstruimos uno equivalente. La mayoría de los servidores
  // matchean el Undo por (actor, object) y no exigen el id exacto — igual
  // que hace nuestro propio handleUndo en el Inbox (módulo 5).
  const innerLike = wrapActivity('Like', newActivityUri(instanceDomain), actorId, target.activity_uri);
  const undo = wrapActivity('Undo', newActivityUri(instanceDomain), actorId, innerLike);

  await deliverActivity({
    inboxUrl: target.shared_inbox_url || target.inbox_url,
    activity: undo,
    keyId: `${actorId}#main-key`,
    privateKeyPem: actorRow.private_key_pem,
  });
}

// ------------------------------------------------------------
// ANNOUNCE / UNDO ANNOUNCE — a diferencia del Like, sí va a nuestros
// followers (un boost aparece en sus timelines), además del autor.
// ------------------------------------------------------------
async function handleAnnounce({ statusId, isRemote, actor: actorStub, activityUri }) {
  const target = await resolveRemoteStatusTarget(statusId, isRemote);
  if (!target) return;

  const instanceDomain = getInstanceDomain();
  const actorRow = await getFullUser(actorStub.id);
  const actorId = actorUrl(actorRow.username, instanceDomain);

  // activityUri ya viene generado desde routes/statuses.js (se guarda en
  // reblogs.activity_uri) — lo reusamos como id de esta misma actividad,
  // en vez de generar uno nuevo que no coincidiría con lo que guardamos.
  const activity = wrapActivity('Announce', activityUri, actorId, target.activity_uri);

  const recipients = new Set(await getFollowerInboxUrls(actorRow.id));
  if (target.inbox_url) recipients.add(target.shared_inbox_url || target.inbox_url);

  await deliverToMany([...recipients], activity, `${actorId}#main-key`, actorRow.private_key_pem);
}

async function handleUndoAnnounce({ statusId, isRemote, actor: actorStub }) {
  const target = await resolveRemoteStatusTarget(statusId, isRemote);
  if (!target) return;

  const instanceDomain = getInstanceDomain();
  const actorRow = await getFullUser(actorStub.id);
  const actorId = actorUrl(actorRow.username, instanceDomain);

  const innerAnnounce = wrapActivity('Announce', newActivityUri(instanceDomain), actorId, target.activity_uri);
  const undo = wrapActivity('Undo', newActivityUri(instanceDomain), actorId, innerAnnounce);

  const recipients = new Set(await getFollowerInboxUrls(actorRow.id));
  if (target.inbox_url) recipients.add(target.shared_inbox_url || target.inbox_url);

  await deliverToMany([...recipients], undo, `${actorId}#main-key`, actorRow.private_key_pem);
}

// ------------------------------------------------------------
// FOLLOW / UNDO FOLLOW
// ------------------------------------------------------------
async function handleFollow({ follower: followerStub, targetActor }) {
  const instanceDomain = getInstanceDomain();
  const followerRow = await getFullUser(followerStub.id);
  const actorId = actorUrl(followerRow.username, instanceDomain);

  const followActivityId = newActivityUri(instanceDomain);
  const activity = wrapActivity('Follow', followActivityId, actorId, targetActor.actor_uri);

  // Guardamos el id de este Follow para poder referenciarlo correctamente
  // si más adelante el usuario deja de seguir (ver handleUndoFollow).
  await pool.query(
    `UPDATE follows SET follow_activity_uri = $1 WHERE follower_user_id = $2 AND followee_actor_id = $3`,
    [followActivityId, followerRow.id, targetActor.id]
  );

  await deliverActivity({
    inboxUrl: targetActor.shared_inbox_url || targetActor.inbox_url,
    activity,
    keyId: `${actorId}#main-key`,
    privateKeyPem: followerRow.private_key_pem,
  });
}

async function handleUndoFollow({ follower: followerStub, targetActor, followActivityUri }) {
  const instanceDomain = getInstanceDomain();
  const followerRow = await getFullUser(followerStub.id);
  const actorId = actorUrl(followerRow.username, instanceDomain);

  // followActivityUri viene de routes/follows.js (lo capturó del follow
  // que se acaba de borrar). Si no está disponible (ej: un follow de
  // antes de este módulo, que nunca lo guardó), reconstruimos uno
  // equivalente — mismo criterio que handleUndoLike.
  const innerFollow = wrapActivity('Follow', followActivityUri || newActivityUri(instanceDomain), actorId, targetActor.actor_uri);
  const undo = wrapActivity('Undo', newActivityUri(instanceDomain), actorId, innerFollow);

  await deliverActivity({
    inboxUrl: targetActor.shared_inbox_url || targetActor.inbox_url,
    activity: undo,
    keyId: `${actorId}#main-key`,
    privateKeyPem: followerRow.private_key_pem,
  });
}

// ------------------------------------------------------------
// Dispatcher + wiring
// ------------------------------------------------------------
async function federationHook(event, payload) {
  switch (event) {
    case 'create': return handleCreate(payload);
    case 'delete': return handleDelete(payload);
    case 'like': return handleLike(payload);
    case 'undo_like': return handleUndoLike(payload);
    case 'announce': return handleAnnounce(payload);
    case 'undo_announce': return handleUndoAnnounce(payload);
    case 'follow': return handleFollow(payload);
    case 'undo_follow': return handleUndoFollow(payload);
    default:
      console.warn(`federationHook: evento desconocido "${event}", se ignora.`);
  }
}

/**
 * Conecta este módulo con los puntos de enganche que routes/statuses.js
 * y routes/follows.js dejaron preparados desde los módulos anteriores.
 * Llamar UNA SOLA VEZ al arrancar el servidor (en index.js), antes de
 * aceptar tráfico.
 */
function initFederation() {
  setStatusesHook(federationHook);
  setFollowsHook(federationHook);
}

module.exports = { initFederation };