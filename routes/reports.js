// routes/reports.js
//
// POST /api/v1/reports — el endpoint estilo Mastodon que Elk (y
// cualquier cliente compatible) usa cuando alguien aprieta "Reportar"
// sobre una cuenta o un post. La bandeja para que los moderadores
// vean/resuelvan estos reportes vive en routes/moderation.js.

const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../lib/authMiddleware');

const router = express.Router();

const VALID_CATEGORIES = ['spam', 'harassment', 'violation', 'other'];

/**
 * POST /api/v1/reports
 * body: {
 *   account_id,       // uuid de users o remote_actors — a quién reporto
 *   status_ids?,      // array de uuids de statuses citados como evidencia
 *   comment?,
 *   category?         // 'spam' | 'harassment' | 'violation' | 'other'
 * }
 */
router.post('/api/v1/reports', requireAuth, async (req, res) => {
  const { account_id: accountId, status_ids: statusIds, comment, category } = req.body || {};

  if (!accountId) {
    return res.status(422).json({ error: 'Falta account_id.' });
  }
  const finalCategory = VALID_CATEGORIES.includes(category) ? category : 'other';
  const finalStatusIds = Array.isArray(statusIds) ? statusIds : [];

  try {
    const localTarget = await pool.query('SELECT id FROM users WHERE id = $1', [accountId]);
    let targetUserId = null;
    let targetActorId = null;

    if (localTarget.rows.length > 0) {
      if (localTarget.rows[0].id === req.authUser.id) {
        return res.status(422).json({ error: 'No puedes reportarte a ti mismo.' });
      }
      targetUserId = accountId;
    } else {
      const remoteTarget = await pool.query('SELECT id FROM remote_actors WHERE id = $1', [accountId]);
      if (remoteTarget.rows.length === 0) {
        return res.status(404).json({ error: 'Cuenta no encontrada.' });
      }
      targetActorId = accountId;
    }

    const result = await pool.query(
      `INSERT INTO reports (reporter_user_id, target_user_id, target_actor_id, status_ids, category, comment)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.authUser.id, targetUserId, targetActorId, finalStatusIds, finalCategory, comment || null]
    );

    // Formato de respuesta estilo Mastodon (lo que Elk espera de vuelta
    // tras reportar), simplificado a lo que realmente usamos.
    return res.status(200).json({
      id: result.rows[0].id,
      action_taken: false,
      category: result.rows[0].category,
      status_ids: result.rows[0].status_ids,
      comment: result.rows[0].comment,
    });
  } catch (err) {
    console.error('Error en POST /api/v1/reports:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

module.exports = router;