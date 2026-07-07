// lib/activitypub.js
//
// Construye las URLs y el objeto "Actor" de ActivityPub para un usuario
// LOCAL. Centralizado aquí porque lo van a necesitar varios módulos:
// - routes/actor.js (este módulo, sirve el Actor)
// - routes/webfinger.js (apunta hacia el Actor)
// - el futuro módulo de Outbox (para firmar actividades salientes con
//   el mismo keyId que publicamos acá)

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

module.exports = { actorUrl, profileUrl, buildActor };