// lib/moderationMiddleware.js
//
// Middleware de permisos para el panel de moderación. Se apoya en
// requireAuth (ya deja req.authUser seteado y validado) y solo agrega
// el chequeo de rol encima.
//
// Jerarquía: admin > moderator > user. Un admin siempre pasa los
// chequeos de moderador (no hace falta que además tenga is_moderator
// en true) — eso evita el caso incómodo de "soy admin pero me olvidé
// de tildarme como moderador también".

const { requireAuth } = require('./authMiddleware');

function isModerator(user) {
  return !!(user && (user.is_admin || user.is_moderator));
}

function isAdmin(user) {
  return !!(user && user.is_admin);
}

/**
 * Exige login + rol de moderador o admin. Usar en cualquier endpoint
 * de acción de moderación (suspender, silenciar, resolver reportes,
 * domain blocks).
 */
async function requireModerator(req, res, next) {
  await requireAuth(req, res, () => {});
  if (!req.authUser) return; // requireAuth ya respondió 401
  if (!isModerator(req.authUser)) {
    return res.status(403).json({ error: 'Se requiere rol de moderador o admin.' });
  }
  return next();
}

/**
 * Exige login + rol de admin. Reservado para lo que cambia el poder
 * de otros (otorgar/quitar moderador, y por consistencia con
 * adminInstance.js, config de la instancia).
 */
async function requireAdmin(req, res, next) {
  await requireAuth(req, res, () => {});
  if (!req.authUser) return;
  if (!isAdmin(req.authUser)) {
    return res.status(403).json({ error: 'Se requiere rol de admin.' });
  }
  return next();
}

module.exports = { requireModerator, requireAdmin, isModerator, isAdmin };