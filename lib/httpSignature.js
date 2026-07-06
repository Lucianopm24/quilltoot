// lib/httpSignature.js
// Implementación mínima de HTTP Signatures (draft-cavage-http-signatures),
// que es el estándar que usa ActivityPub para que un servidor pruebe que
// una actividad realmente viene de quien dice venir.
//
// Dos funciones:
//   - signRequest(...)   -> genera el header "Signature" para peticiones SALIENTES
//   - verifySignature(...) -> valida el header "Signature" de peticiones ENTRANTES

const crypto = require('crypto');

/**
 * Construye el "signing string" a partir de los headers pseudo-HTTP
 * que exige la spec: (request-target), host, date, digest.
 */
function buildSigningString({ method, path, headers }) {
  const lines = [
    `(request-target): ${method.toLowerCase()} ${path}`,
    `host: ${headers.host}`,
    `date: ${headers.date}`,
  ];
  if (headers.digest) {
    lines.push(`digest: ${headers.digest}`);
  }
  return lines.join('\n');
}

/**
 * Calcula el header Digest (SHA-256 del body) que ActivityPub exige
 * en peticiones POST (para que el firmante también cubra el contenido).
 */
function buildDigest(bodyString) {
  const hash = crypto.createHash('sha256').update(bodyString || '').digest('base64');
  return `SHA-256=${hash}`;
}

/**
 * Firma una petición saliente (usada al mandar actividades a otros servidores).
 *
 * @param {object} opts
 * @param {string} opts.method - "GET" o "POST"
 * @param {string} opts.path - path completo, ej: "/inbox"
 * @param {string} opts.host - dominio destino, ej: "mastodon.social"
 * @param {string} opts.privateKeyPem - clave privada del actor que firma
 * @param {string} opts.keyId - URI pública de la clave, ej: "https://tudominio.com/users/luciano#main-key"
 * @param {string} [opts.bodyString] - cuerpo del POST (para el Digest). Vacío en GET.
 * @returns {{headers: object}} headers a añadir a la petición: Date, Digest (si aplica), Signature
 */
function signRequest({ method, path, host, privateKeyPem, keyId, bodyString }) {
  const date = new Date().toUTCString();
  const headers = { host, date };

  let digest;
  if (method.toUpperCase() === 'POST') {
    digest = buildDigest(bodyString);
    headers.digest = digest;
  }

  const signingString = buildSigningString({ method, path, headers });

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingString);
  signer.end();
  const signatureB64 = signer.sign(privateKeyPem).toString('base64');

  const headerNames = digest ? '(request-target) host date digest' : '(request-target) host date';

  const signatureHeader =
    `keyId="${keyId}",algorithm="rsa-sha256",headers="${headerNames}",signature="${signatureB64}"`;

  const result = {
    Date: date,
    Signature: signatureHeader,
  };
  if (digest) result.Digest = digest;

  return { headers: result };
}

/**
 * Parsea el header Signature entrante en sus partes (keyId, algorithm, headers, signature).
 */
function parseSignatureHeader(sigHeader) {
  const parts = {};
  // Formato: keyId="...",algorithm="...",headers="...",signature="..."
  const regex = /(\w+)="([^"]*)"/g;
  let match;
  while ((match = regex.exec(sigHeader)) !== null) {
    parts[match[1]] = match[2];
  }
  return parts;
}

/**
 * Verifica la firma de una petición ENTRANTE (usada en el Inbox).
 *
 * @param {object} opts
 * @param {string} opts.method
 * @param {string} opts.path
 * @param {object} opts.headers - headers crudos de la request (lowercase keys)
 * @param {string} opts.publicKeyPem - clave pública del actor remitente (ya resuelta vía su Actor)
 * @param {string} [opts.rawBody] - cuerpo crudo del POST, para validar el Digest
 * @returns {{valid: boolean, reason?: string}}
 */
function verifySignature({ method, path, headers, publicKeyPem, rawBody }) {
  const sigHeader = headers['signature'];
  if (!sigHeader) {
    return { valid: false, reason: 'No hay header Signature en la petición.' };
  }

  const { keyId, algorithm, headers: signedHeadersList, signature } = parseSignatureHeader(sigHeader);
  if (!signature || !signedHeadersList) {
    return { valid: false, reason: 'Header Signature mal formado.' };
  }
  if (algorithm && algorithm !== 'rsa-sha256') {
    return { valid: false, reason: `Algoritmo no soportado: ${algorithm}` };
  }

  // Si el remitente firmó un Digest, verificamos que coincida con el body real
  // antes de confiar en la firma (evita que alguien reenvíe una firma vieja
  // con un cuerpo distinto).
  if (signedHeadersList.includes('digest')) {
    const expectedDigest = buildDigest(rawBody || '');
    if (headers['digest'] !== expectedDigest) {
      return { valid: false, reason: 'El header Digest no coincide con el cuerpo recibido.' };
    }
  }

  // Reconstruir el signing string EXACTAMENTE con los headers que el
  // remitente dice haber firmado, en el mismo orden.
  const lines = signedHeadersList.split(' ').map((headerName) => {
    if (headerName === '(request-target)') {
      return `(request-target): ${method.toLowerCase()} ${path}`;
    }
    return `${headerName}: ${headers[headerName] || ''}`;
  });
  const signingString = lines.join('\n');

  try {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(signingString);
    verifier.end();
    const isValid = verifier.verify(publicKeyPem, Buffer.from(signature, 'base64'));
    return isValid
      ? { valid: true, keyId }
      : { valid: false, reason: 'La firma no coincide con la clave pública.' };
  } catch (err) {
    return { valid: false, reason: `Error al verificar: ${err.message}` };
  }
}

module.exports = { signRequest, verifySignature, buildDigest };