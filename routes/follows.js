// routes/follows.js
//
// Seguir/dejar de seguir cuentas. Puede ser:
//   - Yo (local) sigo a otro usuario local -> se acepta inmediato (sin
//     soporte de cuentas privadas en la V1, así que siempre 'accepted').
//   - Yo (local) sigo a un actor remoto -> se manda un Follow real por
//     ActivityPub (lo hace el módulo 6, aquí solo dejamos el registro
//     en estado 'pending' hasta que llegue el Accept correspondiente).
//
// Nota: igual que en statuses.js, el envío real de la actividad Follow
// federada se conecta después vía setFederationHook, para no tener que
// tocar este archivo cuando construyamos el módulo de Outbox.

const express = require('express');
const pool = require('../db/pool');
const { requireAuth, attachUserIfPresent } = require('../lib/authMiddleware');
const { serializeLocalAccount, serializeRemoteAccount } = require('../lib/serializers');

const router = express.Router();

let federationHook = null;
function setFederationHook(fn) {
  federationHook = fn;
}
async function queueFederation(event, payload) {
  if (federationHook) {
    try {
      await federationHook(event, payload);
    } catch (err) {
      console.error(`Error federando evento "${event}":`, err);
    }
  }
}

/**
 * Devuelve la "relationship" en formato Mastodon, que es lo que Elk
 * espera como respuesta de /follow y /unfollow (no la cuenta completa).
 */
async function buildRelationship(followerUserId, targetIsRemote, targetId) {
  const col = targetIsRemote ? 'followee_actor_id' : 'followee_user_id';
  const result = await pool.query(
    `SELECT * FROM follows WHERE follower_user_id = $1 AND ${col} = $2`,
    [followerUserId, targetId]
  );
  const follow = result.rows[0];

  return {
    id: targetId,
    following: !!follow && follow.status === 'accepted',
    requested: !!follow && follow.status === 'pending',
    followed_by: false, // no calculamos el lado inverso en la V1 por simplicidad
    blocking: false,
    muting: false,
  };
}

/**
 * POST /api/v1/accounts/:id/follow
 */
router.post('/api/v1/accounts/:id/follow', requireAuth, async (req, res) => {
  const { id } = req.params;

  try {
    const localTarget = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    if (localTarget.rows.length > 0) {
      if (localTarget.rows[0].id === req.authUser.id) {
        return res.status(422).json({ error: 'No puedes seguirte a ti mismo.' });
      }
      await pool.query(
        `INSERT INTO follows (follower_user_id, followee_user_id, status)
         VALUES ($1, $2, 'accepted')
         ON CONFLICT (follower_user_id, followee_user_id) DO NOTHING`,
        [req.authUser.id, id]
      );
      await pool.query('UPDATE users SET followers_count = followers_count + 1 WHERE id = $1', [id]);
      await pool.query('UPDATE users SET following_count = following_count + 1 WHERE id = $1', [req.authUser.id]);

      const relationship = await buildRelationship(req.authUser.id, false, id);
      return res.json(relationship);
    }

    const remoteTarget = await pool.query('SELECT * FROM remote_actors WHERE id = $1', [id]);
    if (remoteTarget.rows.length > 0) {
      await pool.query(
        `INSERT INTO follows (follower_user_id, followee_actor_id, status)
         VALUES ($1, $2, 'pending')
         ON CONFLICT (follower_user_id, followee_actor_id) DO NOTHING`,
        [req.authUser.id, id]
      );
      // El Follow real por ActivityPub lo manda el módulo de federación;
      // el estado pasará a 'accepted' cuando llegue el Accept correspondiente
      // al Inbox (módulo 5).
      await queueFederation('follow', { follower: req.authUser, targetActor: remoteTarget.rows[0] });

      const relationship = await buildRelationship(req.authUser.id, true, id);
      return res.json(relationship);
    }

    return res.status(404).json({ error: 'Cuenta no encontrada.' });
  } catch (err) {
    console.error('Error en POST /api/v1/accounts/:id/follow:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

/**
 * POST /api/v1/accounts/:id/unfollow
 */
router.post('/api/v1/accounts/:id/unfollow', requireAuth, async (req, res) => {
  const { id } = req.params;

  try {
    const localTarget = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    if (localTarget.rows.length > 0) {
      const deleted = await pool.query(
        'DELETE FROM follows WHERE follower_user_id = $1 AND followee_user_id = $2 RETURNING *',
        [req.authUser.id, id]
      );
      if (deleted.rows.length > 0) {
        await pool.query('UPDATE users SET followers_count = GREATEST(followers_count - 1, 0) WHERE id = $1', [id]);
        await pool.query('UPDATE users SET following_count = GREATEST(following_count - 1, 0) WHERE id = $1', [req.authUser.id]);
      }
      const relationship = await buildRelationship(req.authUser.id, false, id);
      return res.json(relationship);
    }

    const remoteTarget = await pool.query('SELECT * FROM remote_actors WHERE id = $1', [id]);
    if (remoteTarget.rows.length > 0) {
      await pool.query('DELETE FROM follows WHERE follower_user_id = $1 AND followee_actor_id = $2', [req.authUser.id, id]);
      await queueFederation('undo_follow', { follower: req.authUser, targetActor: remoteTarget.rows[0] });

      const relationship = await buildRelationship(req.authUser.id, true, id);
      return res.json(relationship);
    }

    return res.status(404).json({ error: 'Cuenta no encontrada.' });
  } catch (err) {
    console.error('Error en POST /api/v1/accounts/:id/unfollow:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

/**
 * GET /api/v1/accounts/:id/followers
 * GET /api/v1/accounts/:id/following
 * Solo cubrimos cuentas locales objetivo por simplicidad en la V1
 * (listar followers/following de un actor remoto requeriría paginar
 * su colección remota, que es un caso más avanzado).
 */
router.get('/api/v1/accounts/:id/followers', attachUserIfPresent, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.* FROM follows f
       JOIN users u ON u.id = f.follower_user_id
       WHERE f.followee_user_id = $1 AND f.status = 'accepted'`,
      [req.params.id]
    );
    const instanceDomain = process.env.INSTANCE_DOMAIN;
    return res.json(result.rows.map((u) => serializeLocalAccount(u, instanceDomain)));
  } catch (err) {
    console.error('Error en GET /api/v1/accounts/:id/followers:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

router.get('/api/v1/accounts/:id/following', attachUserIfPresent, async (req, res) => {
  try {
    const localResult = await pool.query(
      `SELECT u.* FROM follows f
       JOIN users u ON u.id = f.followee_user_id
       WHERE f.follower_user_id = $1 AND f.status = 'accepted'`,
      [req.params.id]
    );
    const remoteResult = await pool.query(
      `SELECT ra.* FROM follows f
       JOIN remote_actors ra ON ra.id = f.followee_actor_id
       WHERE f.follower_user_id = $1 AND f.status = 'accepted'`,
      [req.params.id]
    );
    const instanceDomain = process.env.INSTANCE_DOMAIN;
    const locals = localResult.rows.map((u) => serializeLocalAccount(u, instanceDomain));
    const remotes = remoteResult.rows.map((a) => serializeRemoteAccount(a));
    return res.json([...locals, ...remotes]);
  } catch (err) {
    console.error('Error en GET /api/v1/accounts/:id/following:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

module.exports = { router, setFederationHook };