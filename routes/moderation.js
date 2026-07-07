// routes/moderation.js
//
// Panel de moderación (Módulo 7). Todo bajo /api/v1/moderation, separado
// de adminInstance.js (que es config de la instancia) y de auth.js (que
// es aprobación de registro) — esto es la parte de "ya está adentro,
// ¿se está portando bien?".
//
// Convención de :type/:id para cuentas, IGUAL que follows.js: como los
// ids son UUID (no hay colisión posible entre users y remote_actors),
// resolvemos probando primero users y si no, remote_actors — excepto
// acá que además recibimos type explícito para no ambigüedad en un
// panel de admin (mejor ser explícito que adivinar).

const express = require('express');
const pool = require('../db/pool');
const { requireModerator, requireAdmin } = require('../lib/moderationMiddleware');
const moderation = require('../lib/moderation');

const router = express.Router();

// ------------------------------------------------------------
// Búsqueda de cuentas (para el panel: escribís y te tira resultados
// locales + remotos ya cacheados, con su estado de moderación).
// ------------------------------------------------------------

/**
 * GET /api/v1/moderation/accounts?q=&status=active|suspended|silenced
 */
router.get('/api/v1/moderation/accounts', requireModerator, async (req, res) => {
  const q = `%${(req.query.q || '').trim()}%`;
  const status = req.query.status || 'all';

  try {
    const localWhere = ['(username ILIKE $1 OR email ILIKE $1 OR display_name ILIKE $1)'];
    if (status === 'suspended') localWhere.push('suspended_at IS NOT NULL');
    if (status === 'silenced') localWhere.push('silenced_at IS NOT NULL AND suspended_at IS NULL');
    if (status === 'active') localWhere.push('suspended_at IS NULL AND silenced_at IS NULL');

    const localResult = await pool.query(
      `SELECT id, username, email, display_name, is_admin, is_moderator,
              suspended_at, suspended_reason, silenced_at, silenced_reason, created_at
       FROM users WHERE ${localWhere.join(' AND ')} ORDER BY created_at DESC LIMIT 30`,
      [q]
    );

    const remoteWhere = ['(username ILIKE $1 OR domain ILIKE $1 OR display_name ILIKE $1)'];
    if (status === 'suspended') remoteWhere.push('suspended_at IS NOT NULL');
    if (status === 'silenced') remoteWhere.push('silenced_at IS NOT NULL AND suspended_at IS NULL');
    if (status === 'active') remoteWhere.push('suspended_at IS NULL AND silenced_at IS NULL');

    const remoteResult = await pool.query(
      `SELECT id, username, domain, display_name, actor_uri,
              suspended_at, suspended_reason, silenced_at, silenced_reason, fetched_at
       FROM remote_actors WHERE ${remoteWhere.join(' AND ')} ORDER BY fetched_at DESC LIMIT 30`,
      [q]
    );

    return res.json({
      local: localResult.rows.map((u) => ({ type: 'local', ...u })),
      remote: remoteResult.rows.map((a) => ({ type: 'remote', ...a })),
    });
  } catch (err) {
    console.error('Error en GET /api/v1/moderation/accounts:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

// ------------------------------------------------------------
// Suspender / silenciar — funciona para :type = 'local' | 'remote'
// ------------------------------------------------------------

function validateType(type, res) {
  if (type !== 'local' && type !== 'remote') {
    res.status(400).json({ error: "El parámetro type debe ser 'local' o 'remote'." });
    return false;
  }
  return true;
}

/** POST /api/v1/moderation/accounts/:type/:id/suspend  body: { reason } */
router.post('/api/v1/moderation/accounts/:type/:id/suspend', requireModerator, async (req, res) => {
  const { type, id } = req.params;
  if (!validateType(type, res)) return;
  const reason = req.body?.reason || null;

  try {
    const row =
      type === 'local'
        ? await moderation.suspendUser({ userId: id, reason, moderatorId: req.authUser.id })
        : await moderation.suspendRemoteActor({ actorId: id, reason, moderatorId: req.authUser.id });

    if (!row) return res.status(404).json({ error: 'Cuenta no encontrada.' });
    return res.json({ ok: true, account: row });
  } catch (err) {
    console.error('Error suspendiendo cuenta:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

/** POST /api/v1/moderation/accounts/:type/:id/unsuspend */
router.post('/api/v1/moderation/accounts/:type/:id/unsuspend', requireModerator, async (req, res) => {
  const { type, id } = req.params;
  if (!validateType(type, res)) return;

  try {
    const row =
      type === 'local'
        ? await moderation.unsuspendUser({ userId: id, moderatorId: req.authUser.id })
        : await moderation.unsuspendRemoteActor({ actorId: id, moderatorId: req.authUser.id });

    if (!row) return res.status(404).json({ error: 'Cuenta no encontrada.' });
    return res.json({ ok: true, account: row });
  } catch (err) {
    console.error('Error revirtiendo suspensión:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

/** POST /api/v1/moderation/accounts/:type/:id/silence  body: { reason } */
router.post('/api/v1/moderation/accounts/:type/:id/silence', requireModerator, async (req, res) => {
  const { type, id } = req.params;
  if (!validateType(type, res)) return;
  const reason = req.body?.reason || null;

  try {
    const row =
      type === 'local'
        ? await moderation.silenceUser({ userId: id, reason, moderatorId: req.authUser.id })
        : await moderation.silenceRemoteActor({ actorId: id, reason, moderatorId: req.authUser.id });

    if (!row) return res.status(404).json({ error: 'Cuenta no encontrada.' });
    return res.json({ ok: true, account: row });
  } catch (err) {
    console.error('Error silenciando cuenta:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

/** POST /api/v1/moderation/accounts/:type/:id/unsilence */
router.post('/api/v1/moderation/accounts/:type/:id/unsilence', requireModerator, async (req, res) => {
  const { type, id } = req.params;
  if (!validateType(type, res)) return;

  try {
    const row =
      type === 'local'
        ? await moderation.unsilenceUser({ userId: id, moderatorId: req.authUser.id })
        : await moderation.unsilenceRemoteActor({ actorId: id, moderatorId: req.authUser.id });

    if (!row) return res.status(404).json({ error: 'Cuenta no encontrada.' });
    return res.json({ ok: true, account: row });
  } catch (err) {
    console.error('Error revirtiendo silencio:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

// ------------------------------------------------------------
// Domain blocks
// ------------------------------------------------------------

/** GET /api/v1/moderation/domain_blocks */
router.get('/api/v1/moderation/domain_blocks', requireModerator, async (req, res) => {
  try {
    const blocks = await moderation.listDomainBlocks();
    return res.json({ domain_blocks: blocks });
  } catch (err) {
    console.error('Error en GET /api/v1/moderation/domain_blocks:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

/** POST /api/v1/moderation/domain_blocks  body: { domain, severity, reason } */
router.post('/api/v1/moderation/domain_blocks', requireModerator, async (req, res) => {
  const { domain, severity, reason } = req.body || {};
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    return res.status(422).json({ error: 'domain inválido.' });
  }
  if (severity !== 'silence' && severity !== 'suspend') {
    return res.status(422).json({ error: "severity debe ser 'silence' o 'suspend'." });
  }
  try {
    const block = await moderation.createDomainBlock({ domain, severity, reason, moderatorId: req.authUser.id });
    return res.json({ domain_block: block });
  } catch (err) {
    console.error('Error en POST /api/v1/moderation/domain_blocks:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

/** DELETE /api/v1/moderation/domain_blocks/:domain */
router.delete('/api/v1/moderation/domain_blocks/:domain', requireModerator, async (req, res) => {
  try {
    const removed = await moderation.removeDomainBlock(req.params.domain, req.authUser.id);
    if (!removed) return res.status(404).json({ error: 'No había bloqueo para ese dominio.' });
    return res.json({ ok: true });
  } catch (err) {
    console.error('Error en DELETE /api/v1/moderation/domain_blocks/:domain:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

// ------------------------------------------------------------
// Reportes (bandeja de moderación — el POST para crear un reporte
// vive en routes/reports.js, que es lo que golpea el usuario común)
// ------------------------------------------------------------

/** GET /api/v1/moderation/reports?status=open|resolved|dismissed */
router.get('/api/v1/moderation/reports', requireModerator, async (req, res) => {
  const status = req.query.status || 'open';
  try {
    const result = await pool.query(
      `SELECT r.*,
              reporter.username AS reporter_username,
              tu.username AS target_username,
              ra.username AS target_actor_username, ra.domain AS target_actor_domain
       FROM reports r
       JOIN users reporter ON reporter.id = r.reporter_user_id
       LEFT JOIN users tu ON tu.id = r.target_user_id
       LEFT JOIN remote_actors ra ON ra.id = r.target_actor_id
       WHERE r.status = $1
       ORDER BY r.created_at DESC`,
      [status]
    );
    return res.json({ reports: result.rows });
  } catch (err) {
    console.error('Error en GET /api/v1/moderation/reports:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

/**
 * POST /api/v1/moderation/reports/:id/resolve
 * body: { action: 'resolve' | 'dismiss', note? }
 * Esto NO ejecuta ninguna sanción por sí solo — solo cierra el reporte.
 * Si el moderador decide suspender/silenciar, llama a esos endpoints
 * aparte (así queda auditado como acción independiente en moderation_log).
 */
router.post('/api/v1/moderation/reports/:id/resolve', requireModerator, async (req, res) => {
  const { action, note } = req.body || {};
  if (action !== 'resolve' && action !== 'dismiss') {
    return res.status(422).json({ error: "action debe ser 'resolve' o 'dismiss'." });
  }
  const newStatus = action === 'resolve' ? 'resolved' : 'dismissed';

  try {
    const result = await pool.query(
      `UPDATE reports SET status = $1, handled_by = $2, handled_at = now(), resolution_note = $3
       WHERE id = $4 AND status = 'open' RETURNING *`,
      [newStatus, req.authUser.id, note || null, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Reporte no encontrado o ya estaba resuelto.' });
    }
    await moderation.logModerationAction({
      moderatorId: req.authUser.id,
      action: `report_${newStatus}`,
      targetType: 'report',
      targetId: req.params.id,
      reason: note,
    });
    return res.json({ report: result.rows[0] });
  } catch (err) {
    console.error('Error en POST /api/v1/moderation/reports/:id/resolve:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

// ------------------------------------------------------------
// Roles — solo un admin puede otorgar/quitar moderador. Subir a admin
// NO se expone acá a propósito (eso es config sensible que preferimos
// dejar solo por SQL directo/migración, no por la API).
// ------------------------------------------------------------

/** PATCH /api/v1/moderation/users/:id/role  body: { is_moderator: boolean } */
router.patch('/api/v1/moderation/users/:id/role', requireAdmin, async (req, res) => {
  const { is_moderator } = req.body || {};
  if (typeof is_moderator !== 'boolean') {
    return res.status(422).json({ error: 'is_moderator debe ser boolean.' });
  }
  try {
    const result = await pool.query(
      'UPDATE users SET is_moderator = $1 WHERE id = $2 RETURNING id, username, is_moderator',
      [is_moderator, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado.' });

    await moderation.logModerationAction({
      moderatorId: req.authUser.id,
      action: is_moderator ? 'grant_moderator' : 'revoke_moderator',
      targetType: 'user',
      targetId: req.params.id,
    });
    return res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('Error en PATCH /api/v1/moderation/users/:id/role:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

// ------------------------------------------------------------
// Log de auditoría — para la pestaña "actividad" del panel
// ------------------------------------------------------------

/** GET /api/v1/moderation/log */
router.get('/api/v1/moderation/log', requireModerator, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ml.*, u.username AS moderator_username
       FROM moderation_log ml LEFT JOIN users u ON u.id = ml.moderator_id
       ORDER BY ml.created_at DESC LIMIT 100`
    );
    return res.json({ log: result.rows });
  } catch (err) {
    console.error('Error en GET /api/v1/moderation/log:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

module.exports = router;