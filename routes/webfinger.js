// routes/webfinger.js
//
// Implementa WebFinger (RFC 7033), que es cómo cualquier servidor
// ActivityPub resuelve un handle tipo "@usuario@tudominio.com" hasta
// llegar a la URL real del Actor. Es el primer paso de CUALQUIER
// interacción federada: antes de poder seguir a alguien o que alguien
// te siga, el otro servidor tiene que poder resolverte por WebFinger.
//
// No requiere autenticación — es un endpoint público por diseño.

const express = require('express');
const pool = require('../db/pool');
const { actorUrl, profileUrl } = require('../lib/activitypub');

const router = express.Router();

function getInstanceDomain() {
  if (!process.env.INSTANCE_DOMAIN) {
    throw new Error('Falta la variable de entorno INSTANCE_DOMAIN.');
  }
  return process.env.INSTANCE_DOMAIN;
}

/**
 * GET /.well-known/webfinger?resource=acct:usuario@tudominio.com
 *
 * El "resource" SIEMPRE viene como "acct:usuario@dominio" (con el
 * prefijo "acct:"). Si el dominio no es el nuestro, o el formato no es
 * el esperado, o el usuario no existe, respondemos 404 — no hay nada
 * más que devolver.
 */
router.get('/.well-known/webfinger', async (req, res) => {
  const instanceDomain = getInstanceDomain();
  const resource = req.query.resource;

  if (!resource || typeof resource !== 'string' || !resource.startsWith('acct:')) {
    return res.status(400).json({
      error: 'Falta o es inválido el parámetro resource. Formato esperado: acct:usuario@dominio.',
    });
  }

  const handle = resource.slice('acct:'.length); // "usuario@dominio"
  const [username, domain] = handle.split('@');

  if (!username || !domain) {
    return res.status(400).json({ error: 'Formato de resource inválido. Debe ser acct:usuario@dominio.' });
  }

  if (domain !== instanceDomain) {
    // No es nuestro dominio — no tenemos nada que resolver.
    return res.status(404).json({ error: 'Ese dominio no es esta instancia.' });
  }

  try {
    const result = await pool.query('SELECT username FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado en esta instancia.' });
    }

    const id = actorUrl(username, instanceDomain);

    res.set('Content-Type', 'application/jrd+json');
    return res.json({
      subject: `acct:${username}@${instanceDomain}`,
      aliases: [id, profileUrl(username, instanceDomain)],
      links: [
        {
          rel: 'http://webfinger.net/rel/profile-page',
          type: 'text/html',
          href: profileUrl(username, instanceDomain),
        },
        {
          rel: 'self',
          type: 'application/activity+json',
          href: id,
        },
      ],
    });
  } catch (err) {
    console.error('Error en GET /.well-known/webfinger:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

module.exports = router;