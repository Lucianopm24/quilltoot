// lib/authMiddleware.js
//
// Middleware de Express que valida el header "Authorization: Bearer <token>"
// contra la tabla oauth_tokens y adjunta el usuario autenticado en
// req.authUser. Lo usan tanto rutas que EXIGEN login (statuses, favourite...)
// como rutas donde el login es OPCIONAL pero cambia el comportamiento
// (auth.js usa req.authUser para decidir si permite el registro).

const pool = require('../db/pool');

/**
 * Intenta resolver el usuario a partir del Bearer token, si viene.
 * Nunca corta la petición — deja req.authUser en null si no hay token
 * o es inválido. Útil para rutas donde el login es opcional.
 */
async function attachUserIfPresent(req, res, next) {
  req.authUser = null;

  const authHeader = req.headers['authorization'] || '';
  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next();
  }

  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.is_admin, u.public_key_pem
       FROM oauth_tokens t
       JOIN users u ON u.id = t.user_id
       WHERE t.access_token = $1 AND t.revoked = false`,
      [token]
    );
    req.authUser = result.rows[0] || null;
  } catch (err) {
    console.error('Error validando token en attachUserIfPresent:', err);
    req.authUser = null;
  }

  return next();
}

/**
 * Igual que attachUserIfPresent, pero corta la petición con 401 si no
 * hay un usuario válido. Úsalo en rutas que SIEMPRE requieren login.
 */
async function requireAuth(req, res, next) {
  await attachUserIfPresent(req, res, () => {});
  if (!req.authUser) {
    return res.status(401).json({ error: 'Token inválido, expirado o ausente.' });
  }
  return next();
}

module.exports = { attachUserIfPresent, requireAuth };