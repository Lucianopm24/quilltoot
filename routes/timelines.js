// routes/timelines.js
//
// Timelines y endpoints de cuenta que Elk necesita para armar el feed:
//   - GET /api/v1/timelines/home    -> posts de quien sigo (local + remoto)
//   - GET /api/v1/timelines/public  -> posts públicos de la instancia
//   - GET /api/v1/accounts/verify_credentials -> "quién soy" (justo tras login)
//   - GET /api/v1/accounts/:id
//   - GET /api/v1/accounts/:id/statuses
//   - GET /api/v1/instance -> metadata básica que Elk pide para saber
//     contra qué tipo de servidor está hablando

const express = require('express');
const pool = require('../db/pool');
const { requireAuth, attachUserIfPresent } = require('../lib/authMiddleware');
const { isApprovalRequired, isOpenRegistration } = require('../lib/registrationConfig');
const { getInstanceSettings, getInstanceStats } = require('../lib/instanceSettings');
const {
  serializeLocalAccount,
  serializeRemoteAccount,
  serializeLocalStatus,
  serializeRemoteStatus,
} = require('../lib/serializers');
const { localExclusionClause, remoteExclusionClause, viewerExclusionClause } = require('../lib/moderation');

const router = express.Router();

function getInstanceDomain() {
  if (!process.env.INSTANCE_DOMAIN) {
    throw new Error('Falta la variable de entorno INSTANCE_DOMAIN.');
  }
  return process.env.INSTANCE_DOMAIN;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 40;

function parseLimit(query) {
  const n = parseInt(query.limit, 10);
  if (Number.isNaN(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/**
 * Trae extras (favourited/reblogged/counts) para una LISTA de statuses
 * de una sola vez, para no hacer N+1 queries en el timeline.
 */
async function getExtrasForMany(ids, isRemoteFlags, authUserId) {
  // ids e isRemoteFlags están alineados por índice. Separamos en dos grupos.
  const localIds = ids.filter((id, i) => !isRemoteFlags[i]);
  const remoteIds = ids.filter((id, i) => isRemoteFlags[i]);

  const extrasMap = {};

  async function fillFor(idList, col) {
    if (idList.length === 0) return;
    const favResult = await pool.query(
      `SELECT ${col} AS sid, COUNT(*)::int AS c FROM favourites WHERE ${col} = ANY($1) GROUP BY ${col}`,
      [idList]
    );
    const reblogResult = await pool.query(
      `SELECT ${col} AS sid, COUNT(*)::int AS c FROM reblogs WHERE ${col} = ANY($1) GROUP BY ${col}`,
      [idList]
    );
    const myFavResult = authUserId
      ? await pool.query(`SELECT ${col} AS sid FROM favourites WHERE ${col} = ANY($1) AND user_id = $2`, [idList, authUserId])
      : { rows: [] };
    const myReblogResult = authUserId
      ? await pool.query(`SELECT ${col} AS sid FROM reblogs WHERE ${col} = ANY($1) AND user_id = $2`, [idList, authUserId])
      : { rows: [] };

    for (const id of idList) {
      extrasMap[id] = {
        favourites_count: favResult.rows.find((r) => r.sid === id)?.c || 0,
        reblogs_count: reblogResult.rows.find((r) => r.sid === id)?.c || 0,
        favourited: myFavResult.rows.some((r) => r.sid === id),
        reblogged: myReblogResult.rows.some((r) => r.sid === id),
      };
    }
  }

  await fillFor(localIds, 'status_id');
  await fillFor(remoteIds, 'remote_status_id');

  return extrasMap;
}

/**
 * GET /api/v1/timelines/public
 * Mezcla statuses locales públicos + remote_statuses públicos, ordenados
 * por fecha. Al mezclar dos tablas con paginación por cursor exacta nos
 * complicaríamos mucho para una V1, así que usamos paginación simple por
 * fecha (max_id no soportado todavía — Elk lo tolera, solo scrollea menos).
 */
router.get('/api/v1/timelines/public', attachUserIfPresent, async (req, res) => {
  const instanceDomain = getInstanceDomain();
  const limit = parseLimit(req.query);

  try {
    // Timeline pública: excluye cuentas suspendidas Y silenciadas (una
    // cuenta silenciada sigue siendo visible para quien ya la sigue,
    // pero no debe aparecer en el timeline público/de descubrimiento).
    const localResult = await pool.query(
      `SELECT s.*, u.username, u.display_name, u.bio, u.created_at AS user_created_at,
              u.followers_count, u.following_count, u.statuses_count, u.id AS user_id
       FROM statuses s JOIN users u ON u.id = s.author_id
       WHERE s.visibility = 'public' AND ${localExclusionClause({ includeSilenced: true })}
       ORDER BY s.created_at DESC LIMIT $1`,
      [limit]
    );
    const remoteResult = await pool.query(
      `SELECT rs.*, ra.username, ra.domain, ra.display_name, ra.actor_uri, ra.fetched_at, ra.id AS actor_id
       FROM remote_statuses rs JOIN remote_actors ra ON ra.id = rs.author_actor_id
       WHERE rs.visibility = 'public' AND ${remoteExclusionClause({ includeSilenced: true })}
       ORDER BY rs.received_at DESC LIMIT $1`,
      [limit]
    );

    const localIds = localResult.rows.map((r) => r.id);
    const remoteIds = remoteResult.rows.map((r) => r.id);
    const allIds = [...localIds, ...remoteIds];
    const isRemoteFlags = [...localIds.map(() => false), ...remoteIds.map(() => true)];
    const extrasMap = await getExtrasForMany(allIds, isRemoteFlags, req.authUser?.id);

    const localSerialized = localResult.rows.map((row) =>
      serializeLocalStatus(row, { ...row, id: row.user_id }, instanceDomain, extrasMap[row.id])
    );
    const remoteSerialized = remoteResult.rows.map((row) =>
      serializeRemoteStatus(row, { ...row, id: row.actor_id }, extrasMap[row.id])
    );

    const merged = [...localSerialized, ...remoteSerialized].sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at)
    );

    return res.json(merged.slice(0, limit));
  } catch (err) {
    console.error('Error en GET /api/v1/timelines/public:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

/**
 * GET /api/v1/timelines/home
 * Posts de las cuentas (locales o remotas) que el usuario autenticado sigue,
 * más sus propios posts (así lo hace Mastodon).
 */
router.get('/api/v1/timelines/home', requireAuth, async (req, res) => {
  const instanceDomain = getInstanceDomain();
  const limit = parseLimit(req.query);

  try {
    // IDs de usuarios locales y actores remotos que sigo.
    const followingResult = await pool.query(
      `SELECT followee_user_id, followee_actor_id FROM follows
       WHERE follower_user_id = $1 AND status = 'accepted'`,
      [req.authUser.id]
    );
    const followedUserIds = followingResult.rows.map((r) => r.followee_user_id).filter(Boolean);
    followedUserIds.push(req.authUser.id); // incluir mis propios posts
    const followedActorIds = followingResult.rows.map((r) => r.followee_actor_id).filter(Boolean);

    // Home SÍ muestra cuentas silenciadas (elegiste seguirlas a
    // propósito), pero no suspendidas, ni tampoco a quien vos mismo
    // bloqueaste o muteaste (viewerExclusionClause usa $3 = tu id).
    const localResult = followedUserIds.length
      ? await pool.query(
          `SELECT s.*, u.username, u.display_name, u.bio, u.created_at AS user_created_at,
                  u.followers_count, u.following_count, u.statuses_count, u.id AS user_id
           FROM statuses s JOIN users u ON u.id = s.author_id
           WHERE s.author_id = ANY($1) AND ${localExclusionClause({ includeSilenced: false })}
             AND ${viewerExclusionClause({ viewerParamIndex: 3, localAuthorColumn: 's.author_id' })}
           ORDER BY s.created_at DESC LIMIT $2`,
          [followedUserIds, limit, req.authUser.id]
        )
      : { rows: [] };

    const remoteResult = followedActorIds.length
      ? await pool.query(
          `SELECT rs.*, ra.username, ra.domain, ra.display_name, ra.actor_uri, ra.fetched_at, ra.id AS actor_id
           FROM remote_statuses rs JOIN remote_actors ra ON ra.id = rs.author_actor_id
           WHERE rs.author_actor_id = ANY($1) AND ${remoteExclusionClause({ includeSilenced: false })}
             AND ${viewerExclusionClause({ viewerParamIndex: 3, remoteAuthorColumn: 'rs.author_actor_id' })}
           ORDER BY rs.received_at DESC LIMIT $2`,
          [followedActorIds, limit, req.authUser.id]
        )
      : { rows: [] };

    const localIds = localResult.rows.map((r) => r.id);
    const remoteIds = remoteResult.rows.map((r) => r.id);
    const allIds = [...localIds, ...remoteIds];
    const isRemoteFlags = [...localIds.map(() => false), ...remoteIds.map(() => true)];
    const extrasMap = await getExtrasForMany(allIds, isRemoteFlags, req.authUser.id);

    const localSerialized = localResult.rows.map((row) =>
      serializeLocalStatus(row, { ...row, id: row.user_id }, instanceDomain, extrasMap[row.id])
    );
    const remoteSerialized = remoteResult.rows.map((row) =>
      serializeRemoteStatus(row, { ...row, id: row.actor_id }, extrasMap[row.id])
    );

    const merged = [...localSerialized, ...remoteSerialized].sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at)
    );

    return res.json(merged.slice(0, limit));
  } catch (err) {
    console.error('Error en GET /api/v1/timelines/home:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

/**
 * GET /api/v1/accounts/verify_credentials
 * Lo primero que Elk pide justo después de obtener el access_token.
 */
router.get('/api/v1/accounts/verify_credentials', requireAuth, async (req, res) => {
  const instanceDomain = getInstanceDomain();
  // Nota: serializeLocalAccount() sigue el formato estándar de Mastodon,
  // que Elk espera tal cual (sin campos de rol). Este endpoint en
  // particular es "quién soy yo mismo" — acá sí es seguro y útil sumar
  // is_admin/is_moderator, para que un frontend propio (como el panel
  // de administración) pueda decidir qué mostrar sin pegarle a otra ruta.
  return res.json({
    ...serializeLocalAccount(req.authUser, instanceDomain),
    is_admin: !!req.authUser.is_admin,
    is_moderator: !!req.authUser.is_moderator,
    silenced_at: req.authUser.silenced_at || null,
  });
});

/**
 * GET /api/v1/accounts/lookup?acct=username o username@dominio
 *
 * Endpoint estándar de Mastodon: resuelve una cuenta por su @handle en
 * vez de por id. Lo usa Elk al buscar "@usuario", y también nuestro
 * propio perfil público (/@usuario) para traer los datos a mostrar.
 * Si el dominio en el acct es el nuestro (o no viene dominio), busca en
 * `users`; si es de otra instancia, busca en el cache de `remote_actors`
 * (y devuelve 404 si todavía no la conocemos — no resolvemos vía
 * WebFinger en vivo aquí, eso es trabajo del módulo de federación).
 *
 * IMPORTANTE: esta ruta tiene que registrarse ANTES que
 * "/api/v1/accounts/:id" de abajo. Express matchea rutas en el orden
 * en que se registran, y ":id" es un comodín que matchea CUALQUIER
 * string — incluida la palabra literal "lookup". Si quedara después,
 * todo request a /accounts/lookup caería en :id con id="lookup", y
 * Postgres tira "invalid input syntax for type uuid" al intentar
 * comparar esa columna UUID contra el string "lookup" (justo el 500
 * que viste en los logs).
 */
router.get('/api/v1/accounts/lookup', attachUserIfPresent, async (req, res) => {
  const instanceDomain = getInstanceDomain();
  const acct = (req.query.acct || '').replace(/^@/, '');

  if (!acct) {
    return res.status(400).json({ error: 'Falta el parámetro acct.' });
  }

  const [username, domain] = acct.split('@');

  try {
    if (!domain || domain === instanceDomain) {
      const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Cuenta no encontrada.' });
      }
      return res.json(serializeLocalAccount(result.rows[0], instanceDomain));
    }

    const result = await pool.query(
      'SELECT * FROM remote_actors WHERE username = $1 AND domain = $2',
      [username, domain]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Cuenta remota no encontrada todavía en esta instancia.' });
    }
    return res.json(serializeRemoteAccount(result.rows[0]));
  } catch (err) {
    console.error('Error en GET /api/v1/accounts/lookup:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

/**
 * GET /api/v1/accounts/:id
 * Puede ser un usuario local o un actor remoto cacheado.
 */
router.get('/api/v1/accounts/:id', attachUserIfPresent, async (req, res) => {
  const instanceDomain = getInstanceDomain();
  try {
    const localResult = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (localResult.rows.length > 0) {
      return res.json(serializeLocalAccount(localResult.rows[0], instanceDomain));
    }
    const remoteResult = await pool.query('SELECT * FROM remote_actors WHERE id = $1', [req.params.id]);
    if (remoteResult.rows.length > 0) {
      return res.json(serializeRemoteAccount(remoteResult.rows[0]));
    }
    return res.status(404).json({ error: 'Cuenta no encontrada.' });
  } catch (err) {
    console.error('Error en GET /api/v1/accounts/:id:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

/**
 * GET /api/v1/accounts/:id/statuses
 */
router.get('/api/v1/accounts/:id/statuses', attachUserIfPresent, async (req, res) => {
  const instanceDomain = getInstanceDomain();
  const limit = parseLimit(req.query);

  try {
    const localUser = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (localUser.rows.length > 0) {
      const statusesResult = await pool.query(
        'SELECT * FROM statuses WHERE author_id = $1 ORDER BY created_at DESC LIMIT $2',
        [req.params.id, limit]
      );
      const ids = statusesResult.rows.map((r) => r.id);
      const extrasMap = await getExtrasForMany(ids, ids.map(() => false), req.authUser?.id);
      const serialized = statusesResult.rows.map((row) =>
        serializeLocalStatus(row, localUser.rows[0], instanceDomain, extrasMap[row.id])
      );
      return res.json(serialized);
    }

    const remoteActor = await pool.query('SELECT * FROM remote_actors WHERE id = $1', [req.params.id]);
    if (remoteActor.rows.length > 0) {
      const statusesResult = await pool.query(
        'SELECT * FROM remote_statuses WHERE author_actor_id = $1 ORDER BY received_at DESC LIMIT $2',
        [req.params.id, limit]
      );
      const ids = statusesResult.rows.map((r) => r.id);
      const extrasMap = await getExtrasForMany(ids, ids.map(() => true), req.authUser?.id);
      const serialized = statusesResult.rows.map((row) =>
        serializeRemoteStatus(row, remoteActor.rows[0], extrasMap[row.id])
      );
      return res.json(serialized);
    }

    return res.status(404).json({ error: 'Cuenta no encontrada.' });
  } catch (err) {
    console.error('Error en GET /api/v1/accounts/:id/statuses:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

/**
 * GET /api/v1/instance
 * Elk (y cualquier cliente Mastodon) pide esto para saber el nombre,
 * versión y reglas básicas de la instancia antes/durante el login.
 */
router.get('/api/v1/instance', async (req, res) => {
  const instanceDomain = getInstanceDomain();
  try {
    const [settings, stats] = await Promise.all([getInstanceSettings(), getInstanceStats()]);

    return res.json({
      uri: instanceDomain,
      title: settings.title,
      short_description: settings.short_description,
      description: settings.description,
      email: settings.contact_email,
      version: '4.2.0', // versión de Mastodon que decimos emular, para compatibilidad de features en Elk
      urls: {},
      stats,
      thumbnail: null,
      languages: ['es', 'en'],
      registrations: isOpenRegistration(),
      approval_required: isApprovalRequired(),
      invites_enabled: false,
      configuration: {
        statuses: { max_characters: 500, max_media_attachments: 0 },
        media_attachments: { supported_mime_types: [] },
      },
    });
  } catch (err) {
    console.error('Error en GET /api/v1/instance:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

/**
 * GET /api/v2/instance
 * Desde Mastodon 4.0, es la ruta PRIMARIA que Elk consulta para saber
 * de qué instancia se trata (v1/instance quedó como fallback legado).
 * Si esta ruta no existe, Elk puede terminar con configuración a medias
 * (streaming_api, límites de caracteres, reglas...) y comportarse raro
 * más allá del timeline de inicio. Shape distinto al de v1: no repite
 * los mismos campos, así que va aparte en vez de reusar el de arriba.
 */
router.get('/api/v2/instance', async (req, res) => {
  const instanceDomain = getInstanceDomain();
  try {
    const [settings, stats] = await Promise.all([getInstanceSettings(), getInstanceStats()]);

    return res.json({
      domain: instanceDomain,
      title: settings.title,
      version: '4.2.0',
      source_url: 'https://github.com/Lucianopm24/quilltoot',
      description: settings.description,
      usage: {
        users: { active_month: stats.user_count ?? 0 },
      },
      thumbnail: { url: null },
      icon: [],
      languages: ['es', 'en'],
      configuration: {
        urls: { streaming: null, status: null },
        vapid: { public_key: null },
        accounts: { max_featured_tags: 0 },
        statuses: { max_characters: 500, max_media_attachments: 0, characters_reserved_per_url: 23 },
        media_attachments: { supported_mime_types: [], image_size_limit: 0, video_size_limit: 0 },
        polls: { max_options: 0, max_characters_per_option: 0, min_expiration: 0, max_expiration: 0 },
        translation: { enabled: false },
      },
      registrations: {
        enabled: isOpenRegistration(),
        approval_required: isApprovalRequired(),
        message: null,
        url: null,
      },
      contact: { email: settings.contact_email, account: null },
      rules: [],
      api_versions: { mastodon: 2 },
    });
  } catch (err) {
    console.error('Error en GET /api/v2/instance:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

module.exports = router;