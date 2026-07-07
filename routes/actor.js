// routes/actor.js
//
// Sirve el documento Actor de ActivityPub para cada usuario local
// (GET /users/:username), más sus colecciones followers/following.
// Esto es lo que WebFinger apunta y lo que cualquier servidor remoto
// resuelve para poder mandarnos un Follow, verificar nuestra clave
// pública, etc.
//
// inbox/outbox se exponen como URLs (ver lib/activitypub.js) pero
// TODAVÍA no tienen implementación real — eso llega en los módulos 5
// (Inbox) y 6 (Outbox). Publicarlas ya es necesario porque un Actor sin
// esos campos no es válido ActivityPub, aunque por ahora respondan 404.

const express = require('express');
const pool = require('../db/pool');
const { buildActor, actorUrl } = require('../lib/activitypub');

const router = express.Router();

function getInstanceDomain() {
  if (!process.env.INSTANCE_DOMAIN) {
    throw new Error('Falta la variable de entorno INSTANCE_DOMAIN.');
  }
  return process.env.INSTANCE_DOMAIN;
}

const ACTIVITY_JSON = 'application/activity+json';

/**
 * GET /users/:username
 * El documento Actor en sí. Content-Type application/activity+json,
 * que es lo que Mastodon y el resto del fediverso esperan.
 */
router.get('/users/:username', async (req, res) => {
  const instanceDomain = getInstanceDomain();
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [req.params.username]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    const actor = buildActor(result.rows[0], instanceDomain);
    res.set('Content-Type', ACTIVITY_JSON);
    return res.json(actor);
  } catch (err) {
    console.error('Error en GET /users/:username:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

/**
 * Junta las URIs (locales + remotas) de quienes siguen o son seguidos
 * por un usuario local, para armar las colecciones de abajo.
 */
async function collectActorUris(userId, direction, instanceDomain) {
  // direction: 'followers' (quién me sigue a mí) o 'following' (a quién sigo yo)
  const localCol = direction === 'followers' ? 'follower_user_id' : 'followee_user_id';
  const remoteCol = direction === 'followers' ? 'follower_actor_id' : 'followee_actor_id';
  const matchCol = direction === 'followers' ? 'followee_user_id' : 'follower_user_id';

  const localResult = await pool.query(
    `SELECT u.username FROM follows f
     JOIN users u ON u.id = f.${localCol}
     WHERE f.${matchCol} = $1 AND f.status = 'accepted' AND f.${localCol} IS NOT NULL`,
    [userId]
  );
  const remoteResult = await pool.query(
    `SELECT ra.actor_uri FROM follows f
     JOIN remote_actors ra ON ra.id = f.${remoteCol}
     WHERE f.${matchCol} = $1 AND f.status = 'accepted' AND f.${remoteCol} IS NOT NULL`,
    [userId]
  );

  const localUris = localResult.rows.map((r) => actorUrl(r.username, instanceDomain));
  const remoteUris = remoteResult.rows.map((r) => r.actor_uri);
  return [...localUris, ...remoteUris];
}

/**
 * GET /users/:username/followers
 * GET /users/:username/following
 *
 * Devuelve un OrderedCollection simple (sin paginar) con las URIs de
 * los actores. Para una instancia chica esto es válido y suficiente;
 * si en algún momento la lista crece mucho, se puede convertir a
 * OrderedCollectionPage con "first"/"next".
 */
async function serveCollection(req, res, direction) {
  const instanceDomain = getInstanceDomain();
  try {
    const userResult = await pool.query('SELECT id FROM users WHERE username = $1', [req.params.username]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    const uris = await collectActorUris(userResult.rows[0].id, direction, instanceDomain);
    const id = `${actorUrl(req.params.username, instanceDomain)}/${direction}`;

    res.set('Content-Type', ACTIVITY_JSON);
    return res.json({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id,
      type: 'OrderedCollection',
      totalItems: uris.length,
      orderedItems: uris,
    });
  } catch (err) {
    console.error(`Error en GET /users/:username/${direction}:`, err);
    return res.status(500).json({ error: 'Error interno.' });
  }
}

router.get('/users/:username/followers', (req, res) => serveCollection(req, res, 'followers'));
router.get('/users/:username/following', (req, res) => serveCollection(req, res, 'following'));

module.exports = router;