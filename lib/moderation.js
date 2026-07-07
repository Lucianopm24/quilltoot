// lib/moderation.js
//
// Helpers centrales del Módulo 7 (Moderación). Los usan:
//   - lib/authMiddleware.js (rechazar login de cuentas suspendidas)
//   - routes/inbox.js (rechazar actividades de dominios/actores bloqueados)
//   - routes/timelines.js (filtrar timelines públicas de contenido
//     suspendido/silenciado, y de cuentas bloqueadas/muteadas por el
//     usuario que mira)
//   - routes/moderation.js y routes/reports.js (las acciones en sí)
//
// Todo lo que es una ACCIÓN de moderador (suspender, silenciar, etc.)
// vive acá para que routes/moderation.js sea solo "parsear el request,
// llamar al helper, loguear, responder" — sin SQL propio desperdigado.

const pool = require('../db/pool');

// ------------------------------------------------------------
// Auditoría
// ------------------------------------------------------------
async function logModerationAction({ moderatorId, action, targetType, targetId, reason }) {
  await pool.query(
    `INSERT INTO moderation_log (moderator_id, action, target_type, target_id, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [moderatorId, action, targetType, targetId, reason || null]
  );
}

// ------------------------------------------------------------
// Domain blocks
// ------------------------------------------------------------
async function getDomainBlock(domain) {
  const result = await pool.query('SELECT * FROM domain_blocks WHERE domain = $1', [domain]);
  return result.rows[0] || null;
}

async function listDomainBlocks() {
  const result = await pool.query('SELECT * FROM domain_blocks ORDER BY created_at DESC');
  return result.rows;
}

async function createDomainBlock({ domain, severity, reason, moderatorId }) {
  const result = await pool.query(
    `INSERT INTO domain_blocks (domain, severity, reason, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (domain) DO UPDATE SET severity = EXCLUDED.severity, reason = EXCLUDED.reason
     RETURNING *`,
    [domain, severity, reason || null, moderatorId]
  );
  await logModerationAction({
    moderatorId,
    action: `domain_block_${severity}`,
    targetType: 'domain',
    targetId: domain,
    reason,
  });
  return result.rows[0];
}

async function removeDomainBlock(domain, moderatorId) {
  const result = await pool.query('DELETE FROM domain_blocks WHERE domain = $1 RETURNING *', [domain]);
  if (result.rows.length > 0) {
    await logModerationAction({ moderatorId, action: 'domain_unblock', targetType: 'domain', targetId: domain });
  }
  return result.rows[0] || null;
}

/**
 * Decide qué hacer con una actividad ENTRANTE de un actor remoto ya
 * autenticado (firma verificada). Se llama desde routes/inbox.js justo
 * antes de loguear/despachar.
 *
 * Devuelve { reject: boolean, reason?: string }. Un 'suspend' de dominio
 * o de actor puntual se rechaza en silencio (202 igual, sin loguear el
 * motivo al remitente — así no confirmamos que lo bloqueamos, mismo
 * criterio que Mastodon). Un 'silence' de dominio NO rechaza acá: se
 * procesa y guarda normal, el filtro se aplica después en las timelines.
 */
async function shouldRejectInbound(remoteActor) {
  if (remoteActor.suspended_at) {
    return { reject: true, reason: 'Actor remoto suspendido.' };
  }
  const block = await getDomainBlock(remoteActor.domain);
  if (block && block.severity === 'suspend') {
    return { reject: true, reason: `Dominio ${remoteActor.domain} bloqueado (suspend).` };
  }
  return { reject: false };
}

/**
 * Igual que la anterior, pero para el lado de SALIDA (Outbox): antes de
 * entregarle algo a un inbox remoto, chequeamos si ese dominio está
 * bloqueado en 'suspend' (no tiene sentido mandarle nada a quien
 * bloqueamos, aunque nos siga o le respondamos). 'silence' de dominio
 * no bloquea el envío saliente — solo afecta qué mostramos nosotros.
 */
async function isDomainSuspended(domain) {
  const block = await getDomainBlock(domain);
  return !!(block && block.severity === 'suspend');
}

// ------------------------------------------------------------
// Suspender / silenciar cuentas LOCALES
// ------------------------------------------------------------
async function suspendUser({ userId, reason, moderatorId }) {
  const result = await pool.query(
    `UPDATE users SET suspended_at = now(), suspended_reason = $1, suspended_by = $2
     WHERE id = $3 RETURNING id, username, suspended_at`,
    [reason || null, moderatorId, userId]
  );
  if (result.rows.length > 0) {
    await logModerationAction({ moderatorId, action: 'suspend_user', targetType: 'user', targetId: userId, reason });
  }
  return result.rows[0] || null;
}

async function unsuspendUser({ userId, moderatorId }) {
  const result = await pool.query(
    `UPDATE users SET suspended_at = NULL, suspended_reason = NULL, suspended_by = NULL
     WHERE id = $1 RETURNING id, username`,
    [userId]
  );
  if (result.rows.length > 0) {
    await logModerationAction({ moderatorId, action: 'unsuspend_user', targetType: 'user', targetId: userId });
  }
  return result.rows[0] || null;
}

async function silenceUser({ userId, reason, moderatorId }) {
  const result = await pool.query(
    `UPDATE users SET silenced_at = now(), silenced_reason = $1, silenced_by = $2
     WHERE id = $3 RETURNING id, username, silenced_at`,
    [reason || null, moderatorId, userId]
  );
  if (result.rows.length > 0) {
    await logModerationAction({ moderatorId, action: 'silence_user', targetType: 'user', targetId: userId, reason });
  }
  return result.rows[0] || null;
}

async function unsilenceUser({ userId, moderatorId }) {
  const result = await pool.query(
    `UPDATE users SET silenced_at = NULL, silenced_reason = NULL, silenced_by = NULL
     WHERE id = $1 RETURNING id, username`,
    [userId]
  );
  if (result.rows.length > 0) {
    await logModerationAction({ moderatorId, action: 'unsilence_user', targetType: 'user', targetId: userId });
  }
  return result.rows[0] || null;
}

// ------------------------------------------------------------
// Suspender / silenciar actores REMOTOS puntuales (sin bloquear todo
// el dominio — útil cuando el resto de esa instancia se porta bien)
// ------------------------------------------------------------
async function suspendRemoteActor({ actorId, reason, moderatorId }) {
  const result = await pool.query(
    `UPDATE remote_actors SET suspended_at = now(), suspended_reason = $1, suspended_by = $2
     WHERE id = $3 RETURNING id, username, domain, suspended_at`,
    [reason || null, moderatorId, actorId]
  );
  if (result.rows.length > 0) {
    await logModerationAction({ moderatorId, action: 'suspend_remote_actor', targetType: 'remote_actor', targetId: actorId, reason });
  }
  return result.rows[0] || null;
}

async function unsuspendRemoteActor({ actorId, moderatorId }) {
  const result = await pool.query(
    `UPDATE remote_actors SET suspended_at = NULL, suspended_reason = NULL, suspended_by = NULL
     WHERE id = $1 RETURNING id, username, domain`,
    [actorId]
  );
  if (result.rows.length > 0) {
    await logModerationAction({ moderatorId, action: 'unsuspend_remote_actor', targetType: 'remote_actor', targetId: actorId });
  }
  return result.rows[0] || null;
}

async function silenceRemoteActor({ actorId, reason, moderatorId }) {
  const result = await pool.query(
    `UPDATE remote_actors SET silenced_at = now(), silenced_reason = $1, silenced_by = $2
     WHERE id = $3 RETURNING id, username, domain, silenced_at`,
    [reason || null, moderatorId, actorId]
  );
  if (result.rows.length > 0) {
    await logModerationAction({ moderatorId, action: 'silence_remote_actor', targetType: 'remote_actor', targetId: actorId, reason });
  }
  return result.rows[0] || null;
}

async function unsilenceRemoteActor({ actorId, moderatorId }) {
  const result = await pool.query(
    `UPDATE remote_actors SET silenced_at = NULL, silenced_reason = NULL, silenced_by = NULL
     WHERE id = $1 RETURNING id, username, domain`,
    [actorId]
  );
  if (result.rows.length > 0) {
    await logModerationAction({ moderatorId, action: 'unsilence_remote_actor', targetType: 'remote_actor', targetId: actorId });
  }
  return result.rows[0] || null;
}

// ------------------------------------------------------------
// Filtros de exclusión para SQL de timelines/búsqueda.
//
// Devuelven fragmentos WHERE reutilizables. Se usan con NOT EXISTS /
// JOIN condicional en vez de traer todo y filtrar en JS, porque las
// timelines ya paginan con LIMIT — filtrar después del LIMIT rompería
// la paginación (podrías traer 20 filas y que 15 se caigan del filtro).
// ------------------------------------------------------------

/** Cuentas locales suspendidas o (para vistas públicas) silenciadas. */
function localExclusionClause({ includeSilenced }) {
  return includeSilenced
    ? `u.suspended_at IS NULL AND u.silenced_at IS NULL`
    : `u.suspended_at IS NULL`;
}

/**
 * Actores remotos suspendidos/silenciados o cuyo dominio está bloqueado
 * (en 'suspend' siempre se excluye; en 'silence' solo se excluye de
 * vistas públicas, ra es el alias de remote_actors en la query.
 */
function remoteExclusionClause({ includeSilenced }) {
  const base = `ra.suspended_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM domain_blocks db WHERE db.domain = ra.domain AND db.severity = 'suspend')`;
  if (!includeSilenced) return base;
  return `${base}
    AND ra.silenced_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM domain_blocks db2 WHERE db2.domain = ra.domain AND db2.severity = 'silence')`;
}

/**
 * Bloqueos/mutes del usuario que está mirando la timeline: excluye
 * autores locales bloqueados/muteados y actores remotos bloqueados/
 * muteados por él. Se usa solo en timelines autenticadas (home), no en
 * la pública (ahí no hay "quién mira" para filtrar).
 */
function viewerExclusionClause({ viewerParamIndex, localAuthorColumn, remoteAuthorColumn }) {
  const p = viewerParamIndex;
  const clauses = [];
  if (localAuthorColumn) {
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM user_blocks ub WHERE ub.blocker_user_id = $${p} AND ub.blocked_user_id = ${localAuthorColumn}
    ) AND NOT EXISTS (
      SELECT 1 FROM user_mutes um WHERE um.muter_user_id = $${p} AND um.muted_user_id = ${localAuthorColumn}
    ) AND NOT EXISTS (
      SELECT 1 FROM user_blocks ub2 WHERE ub2.blocked_user_id = $${p} AND ub2.blocker_user_id = ${localAuthorColumn}
    )`);
  }
  if (remoteAuthorColumn) {
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM user_blocks ub3 WHERE ub3.blocker_user_id = $${p} AND ub3.blocked_actor_id = ${remoteAuthorColumn}
    ) AND NOT EXISTS (
      SELECT 1 FROM user_mutes um2 WHERE um2.muter_user_id = $${p} AND um2.muted_actor_id = ${remoteAuthorColumn}
    )`);
  }
  return clauses.join(' AND ');
}

// ------------------------------------------------------------
// Bloqueos/mutes de USUARIO (no de instancia) — usados por
// routes/follows.js para los endpoints /block, /mute, etc.
// ------------------------------------------------------------
async function isBlockedEitherWay(userId, targetIsRemote, targetId) {
  const col = targetIsRemote ? 'blocked_actor_id' : 'blocked_user_id';
  if (targetIsRemote) {
    const r = await pool.query(
      `SELECT 1 FROM user_blocks WHERE blocker_user_id = $1 AND blocked_actor_id = $2`,
      [userId, targetId]
    );
    return r.rows.length > 0;
  }
  const r = await pool.query(
    `SELECT 1 FROM user_blocks
     WHERE (blocker_user_id = $1 AND blocked_user_id = $2)
        OR (blocker_user_id = $2 AND blocked_user_id = $1)`,
    [userId, targetId]
  );
  return r.rows.length > 0;
}

module.exports = {
  logModerationAction,
  getDomainBlock,
  listDomainBlocks,
  createDomainBlock,
  removeDomainBlock,
  shouldRejectInbound,
  isDomainSuspended,
  suspendUser,
  unsuspendUser,
  silenceUser,
  unsilenceUser,
  suspendRemoteActor,
  unsuspendRemoteActor,
  silenceRemoteActor,
  unsilenceRemoteActor,
  localExclusionClause,
  remoteExclusionClause,
  viewerExclusionClause,
  isBlockedEitherWay,
};