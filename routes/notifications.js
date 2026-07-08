// routes/notifications.js
//
// GET /api/v1/notifications — el feed que alimenta la campanita en Elk.
// GET /api/v1/notifications/:id — una puntual.
// POST /api/v1/notifications/clear — marca todas como leídas (Elk la
//   llama al abrir la pestaña de notificaciones).
// POST /api/v1/notifications/:id/dismiss — descarta una sola.
//
// Las filas de `notifications` las inserta lib/notifications.js desde
// follows.js, statuses.js y lib/inboxHandlers.js, en el momento en que
// ocurre cada evento (follow, favourite, reblog, reply). Esta ruta solo
// LEE esa tabla y arma el shape que Mastodon/Elk esperan.

const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../lib/authMiddleware');
const {
  serializeLocalAccount,
  serializeRemoteAccount,
  serializeLocalStatus,
  serializeRemoteStatus,
  serializeNotification,
} = require('../lib/serializers');

const router = express.Router();

function getInstanceDomain() {
  if (!process.env.INSTANCE_DOMAIN) {
    throw new Error('Falta la variable de entorno INSTANCE_DOMAIN.');
  }
  return process.env.INSTANCE_DOMAIN;
}

/**
 * Resuelve el `account` (local o remoto) y el `status` (local o remoto,
 * si aplica) de una fila de `notifications`, ya serializados.
 */
async function hydrateNotification(row, instanceDomain) {
  let account;
  if (row.actor_user_id) {
    const u = await pool.query('SELECT * FROM users WHERE id = $1', [row.actor_user_id]);
    if (!u.rows[0]) return null; // el actor fue borrado desde entonces
    account = serializeLocalAccount(u.rows[0], instanceDomain);
  } else {
    const a = await pool.query('SELECT * FROM remote_actors WHERE id = $1', [row.actor_actor_id]);
    if (!a.rows[0]) return null;
    account = serializeRemoteAccount(a.rows[0]);
  }

  let status;
  if (row.status_id) {
    const s = await pool.query('SELECT * FROM statuses WHERE id = $1', [row.status_id]);
    if (s.rows[0]) {
      const author = await pool.query('SELECT * FROM users WHERE id = $1', [s.rows[0].author_id]);
      status = serializeLocalStatus(s.rows[0], author.rows[0], instanceDomain);
    }
  } else if (row.remote_status_id) {
    const s = await pool.query('SELECT * FROM remote_statuses WHERE id = $1', [row.remote_status_id]);
    if (s.rows[0]) {
      const actor = await pool.query('SELECT * FROM remote_actors WHERE id = $1', [s.rows[0].author_actor_id]);
      status = serializeRemoteStatus(s.rows[0], actor.rows[0]);
    }
  }

  return serializeNotification(row, account, status);
}

/**
 * GET /api/v1/notifications
 * Soporta paginación tipo Mastodon con max_id/since_id/limit (Elk las
 * usa para "cargar más" al scrollear). types[]/exclude_types[] también
 * son estándar de la API; los soportamos por si Elk los manda al
 * filtrar por tipo de notificación.
 */
router.get('/api/v1/notifications', requireAuth, async (req, res) => {
  const instanceDomain = getInstanceDomain();
  const limit = Math.min(parseInt(req.query.limit, 10) || 15, 40);

  const conditions = ['recipient_user_id = $1'];
  const params = [req.authUser.id];

  if (req.query.max_id) {
    params.push(req.query.max_id);
    conditions.push(`created_at < (SELECT created_at FROM notifications WHERE id = $${params.length})`);
  }
  if (req.query.since_id) {
    params.push(req.query.since_id);
    conditions.push(`created_at > (SELECT created_at FROM notifications WHERE id = $${params.length})`);
  }

  let types = req.query['types[]'] ?? req.query.types;
  if (types && !Array.isArray(types)) types = [types];
  if (types && types.length > 0) {
    params.push(types);
    conditions.push(`type = ANY($${params.length})`);
  }

  let excludeTypes = req.query['exclude_types[]'] ?? req.query.exclude_types;
  if (excludeTypes && !Array.isArray(excludeTypes)) excludeTypes = [excludeTypes];
  if (excludeTypes && excludeTypes.length > 0) {
    params.push(excludeTypes);
    conditions.push(`NOT (type = ANY($${params.length}))`);
  }

  params.push(limit);

  try {
    const result = await pool.query(
      `SELECT * FROM notifications WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );

    const hydrated = await Promise.all(result.rows.map((row) => hydrateNotification(row, instanceDomain)));
    return res.json(hydrated.filter(Boolean));
  } catch (err) {
    console.error('Error en GET /api/v1/notifications:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

/**
 * GET /api/v1/notifications/:id
 */
router.get('/api/v1/notifications/:id', requireAuth, async (req, res) => {
  const instanceDomain = getInstanceDomain();
  try {
    const result = await pool.query(
      'SELECT * FROM notifications WHERE id = $1 AND recipient_user_id = $2',
      [req.params.id, req.authUser.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Notificación no encontrada.' });

    const hydrated = await hydrateNotification(result.rows[0], instanceDomain);
    if (!hydrated) return res.status(404).json({ error: 'Notificación no encontrada.' });
    return res.json(hydrated);
  } catch (err) {
    console.error('Error en GET /api/v1/notifications/:id:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

/**
 * POST /api/v1/notifications/clear
 * Mastodon marca todas como leídas (no las borra). Elk la llama al
 * abrir la pestaña de notificaciones.
 */
router.post('/api/v1/notifications/clear', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE notifications SET read_at = now() WHERE recipient_user_id = $1 AND read_at IS NULL`,
      [req.authUser.id]
    );
    return res.json({});
  } catch (err) {
    console.error('Error en POST /api/v1/notifications/clear:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

/**
 * POST /api/v1/notifications/:id/dismiss
 */
router.post('/api/v1/notifications/:id/dismiss', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM notifications WHERE id = $1 AND recipient_user_id = $2 RETURNING id',
      [req.params.id, req.authUser.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Notificación no encontrada.' });
    return res.json({});
  } catch (err) {
    console.error('Error en POST /api/v1/notifications/:id/dismiss:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

module.exports = router;