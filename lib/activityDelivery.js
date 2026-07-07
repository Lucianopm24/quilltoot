// lib/activityDelivery.js
//
// Manda una actividad ActivityPub firmada al inbox de otro servidor.
// Lo necesita el Inbox (módulo 5) para responder Accept a un Follow
// entrante, y lo reutilizará el Outbox (módulo 6) para todo lo demás
// (Create, Like, Announce, Follow salientes...) — por eso vive en su
// propio archivo y no dentro de inboxHandlers.js.

const { signRequest } = require('./httpSignature');

const ACTIVITY_JSON = 'application/activity+json';

/**
 * @param {object} opts
 * @param {string} opts.inboxUrl - URL completa del inbox destino
 * @param {object} opts.activity - objeto de actividad ActivityPub a mandar
 * @param {string} opts.keyId - ej: https://tudominio.com/users/luciano#main-key
 * @param {string} opts.privateKeyPem - clave privada del actor que firma (el nuestro)
 */
async function deliverActivity({ inboxUrl, activity, keyId, privateKeyPem }) {
  const url = new URL(inboxUrl);
  const bodyString = JSON.stringify(activity);

  const { headers: signedHeaders } = signRequest({
    method: 'POST',
    path: `${url.pathname}${url.search}`,
    host: url.host,
    privateKeyPem,
    keyId,
    bodyString,
  });

  const response = await fetch(inboxUrl, {
    method: 'POST',
    headers: {
      'Content-Type': ACTIVITY_JSON,
      Host: url.host,
      Date: signedHeaders.Date,
      Digest: signedHeaders.Digest,
      Signature: signedHeaders.Signature,
    },
    body: bodyString,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`El inbox remoto respondió ${response.status} al entregar ${activity.type}: ${text.slice(0, 300)}`);
  }

  return response;
}

module.exports = { deliverActivity };