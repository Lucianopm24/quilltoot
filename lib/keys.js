// lib/keys.js
// Genera el par de claves RSA que cada usuario local necesita para
// ActivityPub: la pública se publica en su Actor (para que otros
// servidores verifiquen su identidad), la privada se usa para firmar
// las actividades que mandamos (Follow, Create, Like, Announce...).

const crypto = require('crypto');

function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

module.exports = { generateKeyPair };