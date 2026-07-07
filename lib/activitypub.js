// lib/activitypub.js
//
// Construye las URLs y el objeto "Actor" de ActivityPub para un usuario
// LOCAL. Centralizado aquí porque lo van a necesitar varios módulos:
// - routes/actor.js (este módulo, sirve el Actor)
// - routes/webfinger.js (apunta hacia el Actor)
// - el futuro módulo de Outbox (para firmar actividades salientes con
//   el mismo keyId que publicamos acá)

const crypto = require('crypto');

function actorUrl(username, instanceDomain) {
  return `https://${instanceDomain}/users/${username}`;
}

function profileUrl(username, instanceDomain) {
  return `https://${instanceDomain}/@${username}`;
}

/**
 * Construye el documento Actor (tipo "Person") que ActivityPub exige.
 * inbox/outbox apuntan a rutas que se implementan en los módulos 5 y 6 —
 * por ahora existen como URLs válidas aunque todavía respondan 404,
 * porque un Actor sin esos campos no es válido para otros servidores.
 */
function buildActor(user, instanceDomain) {
  const id = actorUrl(user.username, instanceDomain);

  return {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      'https://w3id.org/security/v1',
    ],
    id,
    type: 'Person',
    preferredUsername: user.username,
    name: user.display_name || user.username,
    summary: user.bio || '',
    url: profileUrl(user.username, instanceDomain),

    inbox: `${id}/inbox`,
    outbox: `${id}/outbox`,
    followers: `${id}/followers`,
    following: `${id}/following`,

    publicKey: {
      id: `${id}#main-key`,
      owner: id,
      publicKeyPem: user.public_key_pem,
    },
  };
}

/**
 * URI nueva para cualquier actividad que mandemos (Create, Like, Follow...).
 * Mismo patrón que ya usaba routes/statuses.js para el activity_uri de un reblog.
 */
function newActivityUri(instanceDomain) {
  return `https://${instanceDomain}/activities/${crypto.randomUUID()}`;
}

/**
 * Construye el objeto "Note" de un status LOCAL, para mandarlo dentro de
 * un Create a los followers remotos. `opts.inReplyToUri` es la URI (local
 * o remota) del status al que responde, si aplica.
 */
function buildNoteObject(status, author, instanceDomain, opts = {}) {
  const actorId = actorUrl(author.username, instanceDomain);
  const isPublic = status.visibility === 'public' || status.visibility === 'unlisted';

  return {
    id: status.activity_uri,
    type: 'Note',
    attributedTo: actorId,
    content: status.content,
    summary: status.content_warning || null,
    published: new Date(status.created_at).toISOString(),
    to: isPublic ? ['https://www.w3.org/ns/activitystreams#Public'] : [`${actorId}/followers`],
    cc: isPublic ? [`${actorId}/followers`] : [],
    inReplyTo: opts.inReplyToUri || null,
  };
}

/**
 * Envoltorio genérico para cualquier actividad saliente (Create, Delete,
 * Like, Announce, Follow, Undo...). `object` puede ser un objeto completo
 * (ej: la Note de un Create) o solo una URI (ej: el status_uri de un Like).
 */
function wrapActivity(type, id, actorId, object, extra = {}) {
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id,
    type,
    actor: actorId,
    object,
    published: new Date().toISOString(),
    ...extra,
  };
}

module.exports = { actorUrl, profileUrl, buildActor, newActivityUri, buildNoteObject, wrapActivity };