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
const { isBlockedEitherWay } = require('../lib/moderation');
const { createNotification } = require('../lib/notifications');

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

  const blockCol = targetIsRemote ? 'blocked_actor_id' : 'blocked_user_id';
  const blockResult = await pool.query(
    `SELECT 1 FROM user_blocks WHERE blocker_user_id = $1 AND ${blockCol} = $2`,
    [followerUserId, targetId]
  );
  const muteCol = targetIsRemote ? 'muted_actor_id' : 'muted_user_id';
  const muteResult = await pool.query(
    `SELECT 1 FROM user_mutes WHERE muter_user_id = $1 AND ${muteCol} = $2`,
    [followerUserId, targetId]
  );

  return {
    id: targetId,
    following: !!follow && follow.status === 'accepted',
    requested: !!follow && follow.status === 'pending',
    followed_by: false, // no calculamos el lado inverso en la V1 por simplicidad
    blocking: blockResult.rows.length > 0,
    muting: muteResult.rows.length > 0,
  };
}

/**
 * GET /api/v1/accounts/relationships?id[]=uuid1&id[]=uuid2...
 *
 * Elk la llama constantemente (timeline, perfiles, resultados de
 * búsqueda) para saber si ya seguís/bloqueaste/muteaste a cada cuenta
 * que te muestra. No existía, por eso el 500/404 que reportaste.
 *
 * Express parsea "id[]=a&id[]=b" como req.query.id = ['a','b'], pero
 * también aceptamos "id=a" suelto (un solo id, sin corchetes).
 */
router.get('/api/v1/accounts/relationships', requireAuth, async (req, res) => {
  let ids = req.query.id ?? req.query['id[]'];
  if (!ids) return res.json([]);
  if (!Array.isArray(ids)) ids = [ids];

  try {
    const relationships = await Promise.all(
      ids.map(async (targetId) => {
        const localTarget = await pool.query('SELECT id FROM users WHERE id = $1', [targetId]);
        const isRemote = localTarget.rows.length === 0;
        if (isRemote) {
          const remoteTarget = await pool.query('SELECT id FROM remote_actors WHERE id = $1', [targetId]);
          if (remoteTarget.rows.length === 0) return null; // id inexistente: se omite, no rompe el batch
        }
        return buildRelationship(req.authUser.id, isRemote, targetId);
      })
    );
    return res.json(relationships.filter(Boolean));
  } catch (err) {
    console.error('Error en GET /api/v1/accounts/relationships:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

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
      if (await isBlockedEitherWay(req.authUser.id, false, id)) {
        return res.status(403).json({ error: 'No puedes seguir a esta cuenta.' });
      }
      await pool.query(
        `INSERT INTO follows (follower_user_id, followee_user_id, status)
         VALUES ($1, $2, 'accepted')
         ON CONFLICT (follower_user_id, followee_user_id) DO NOTHING`,
        [req.authUser.id, id]
      );
      await pool.query('UPDATE users SET followers_count = followers_count + 1 WHERE id = $1', [id]);
      await pool.query('UPDATE users SET following_count = following_count + 1 WHERE id = $1', [req.authUser.id]);

      await createNotification({
        recipientUserId: id,
        type: 'follow',
        actorUserId: req.authUser.id,
      });

      const relationship = await buildRelationship(req.authUser.id, false, id);
      return res.json(relationship);
    }

    const remoteTarget = await pool.query('SELECT * FROM remote_actors WHERE id = $1', [id]);
    if (remoteTarget.rows.length > 0) {
      if (await isBlockedEitherWay(req.authUser.id, true, id)) {
        return res.status(403).json({ error: 'No puedes seguir a esta cuenta.' });
      }
      await pool.query(
        `INSERT INTO follows (follower_user_id, followee_actor_id, status)
         VALUES ($1, $2, 'pending')
         ON CONFLICT (follower_user_id, followee_actor_id) DO NOTHING`,
        [req.authUser.id, id]
      );
      // El Follow real por ActivityPub lo manda el módulo de federación;
      // el estado pasará a 'accepted' cuando llegue el Accept correspondiente
      // al Inbox (módulo 5). Deliberadamente NO se espera (sin await) a que
      // termine de entregarse: el registro 'pending' ya quedó guardado, así
      // que Elk puede recibir la respuesta ya mismo. Si esperáramos acá, un
      // inbox remoto lento (o antes del fix, colgado sin timeout) dejaba el
      // botón de "Seguir" en Elk cargando indefinidamente.
      queueFederation('follow', { follower: req.authUser, targetActor: remoteTarget.rows[0] })
        .catch((err) => console.error('Error federando follow (async):', err));

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
      // RETURNING follow_activity_uri: lo necesita el federationHook para
      // armar un Undo{Follow} que referencie el Follow original que mandamos,
      // en vez de uno sintético (más correcto para servidores remotos que
      // validan que el Undo apunte a una actividad que realmente conocen).
      const deletedFollow = await pool.query(
        'DELETE FROM follows WHERE follower_user_id = $1 AND followee_actor_id = $2 RETURNING follow_activity_uri',
        [req.authUser.id, id]
      );
      await queueFederation('undo_follow', {
        follower: req.authUser,
        targetActor: remoteTarget.rows[0],
        followActivityUri: deletedFollow.rows[0]?.follow_activity_uri || null,
      });

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

// ------------------------------------------------------------
// BLOCK / UNBLOCK
//
// Bloquear corta el follow en AMBOS sentidos (yo dejo de seguirlo, y
// si él/ella me seguía, también se corta) y evita que vuelva a
// seguirme mientras dure el bloqueo (lo chequeamos en /follow). No le
// avisamos al bloqueado — igual que Mastodon, esto no es una fricción
// pensada para que el otro lado se entere.
// ------------------------------------------------------------
router.post('/api/v1/accounts/:id/block', requireAuth, async (req, res) => {
  const { id } = req.params;
  if (id === req.authUser.id) {
    return res.status(422).json({ error: 'No puedes bloquearte a ti mismo.' });
  }

  try {
    const localTarget = await pool.query('SELECT id FROM users WHERE id = $1', [id]);
    const isRemote = localTarget.rows.length === 0;
    if (isRemote) {
      const remoteTarget = await pool.query('SELECT id FROM remote_actors WHERE id = $1', [id]);
      if (remoteTarget.rows.length === 0) return res.status(404).json({ error: 'Cuenta no encontrada.' });
    }

    const col = isRemote ? 'blocked_actor_id' : 'blocked_user_id';
    await pool.query(
      `INSERT INTO user_blocks (blocker_user_id, ${col}) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [req.authUser.id, id]
    );

    // Cortar el follow en ambos sentidos.
    const followeeCol = isRemote ? 'followee_actor_id' : 'followee_user_id';
    const followerCol = isRemote ? 'follower_actor_id' : 'follower_user_id';
    await pool.query(`DELETE FROM follows WHERE follower_user_id = $1 AND ${followeeCol} = $2`, [req.authUser.id, id]);
    if (!isRemote) {
      // El lado inverso (que el bloqueado me siga a mí) solo aplica a
      // cuentas locales — un follower remoto que nos sigue vive en
      // `follows` con follower_actor_id, no follower_user_id de otro user.
      await pool.query(`DELETE FROM follows WHERE follower_user_id = $1 AND followee_user_id = $2`, [id, req.authUser.id]);
    } else {
      await pool.query(`DELETE FROM follows WHERE ${followerCol} = $1 AND followee_user_id = $2`, [id, req.authUser.id]);
    }

    const relationship = await buildRelationship(req.authUser.id, isRemote, id);
    return res.json(relationship);
  } catch (err) {
    console.error('Error en POST /api/v1/accounts/:id/block:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

router.post('/api/v1/accounts/:id/unblock', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const localTarget = await pool.query('SELECT id FROM users WHERE id = $1', [id]);
    const isRemote = localTarget.rows.length === 0;
    const col = isRemote ? 'blocked_actor_id' : 'blocked_user_id';
    await pool.query(`DELETE FROM user_blocks WHERE blocker_user_id = $1 AND ${col} = $2`, [req.authUser.id, id]);

    const relationship = await buildRelationship(req.authUser.id, isRemote, id);
    return res.json(relationship);
  } catch (err) {
    console.error('Error en POST /api/v1/accounts/:id/unblock:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

// ------------------------------------------------------------
// MUTE / UNMUTE
//
// A diferencia de bloquear, mutear NO toca el follow: sigo siguiendo
// (o siéndole seguido por) esa cuenta, solo dejo de ver sus posts en
// mi timeline (y, si notifications=true, también sus notificaciones).
// ------------------------------------------------------------
router.post('/api/v1/accounts/:id/mute', requireAuth, async (req, res) => {
  const { id } = req.params;
  const notifications = req.body?.notifications !== false; // default true, igual que Mastodon
  if (id === req.authUser.id) {
    return res.status(422).json({ error: 'No puedes mutearte a ti mismo.' });
  }

  try {
    const localTarget = await pool.query('SELECT id FROM users WHERE id = $1', [id]);
    const isRemote = localTarget.rows.length === 0;
    if (isRemote) {
      const remoteTarget = await pool.query('SELECT id FROM remote_actors WHERE id = $1', [id]);
      if (remoteTarget.rows.length === 0) return res.status(404).json({ error: 'Cuenta no encontrada.' });
    }

    const col = isRemote ? 'muted_actor_id' : 'muted_user_id';
    await pool.query(
      `INSERT INTO user_mutes (muter_user_id, ${col}, notifications) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [req.authUser.id, id, notifications]
    );

    const relationship = await buildRelationship(req.authUser.id, isRemote, id);
    return res.json(relationship);
  } catch (err) {
    console.error('Error en POST /api/v1/accounts/:id/mute:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

router.post('/api/v1/accounts/:id/unmute', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const localTarget = await pool.query('SELECT id FROM users WHERE id = $1', [id]);
    const isRemote = localTarget.rows.length === 0;
    const col = isRemote ? 'muted_actor_id' : 'muted_user_id';
    await pool.query(`DELETE FROM user_mutes WHERE muter_user_id = $1 AND ${col} = $2`, [req.authUser.id, id]);

    const relationship = await buildRelationship(req.authUser.id, isRemote, id);
    return res.json(relationship);
  } catch (err) {
    console.error('Error en POST /api/v1/accounts/:id/unmute:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

module.exports = { router, setFederationHook };