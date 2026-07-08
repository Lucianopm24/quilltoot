// routes/search.js
//
// GET /api/v2/search (y /api/v1/search, mismo shape, por compatibilidad
// con clientes viejos) — esto es lo que Elk usa tanto para la barra de
// búsqueda como, más importante, para RESOLVER una cuenta remota que
// todavía no conocemos ("@fulano@mastodon.social") antes de poder
// seguirla: sin esta ruta, no había forma de meter un actor nuevo en
// `remote_actors` desde el cliente, así que buscar/seguir gente nueva
// no funcionaba en absoluto.
//
// Tres formas de "q" que reconocemos, en este orden:
//   1. Una URL (http/https)         -> puede ser un Actor o un Status.
//   2. Un handle "usuario@dominio"  -> cuenta local o remota (WebFinger
//                                       si no la teníamos y resolve=true).
//   3. Texto libre                  -> ILIKE simple sobre cuentas y
//                                       statuses locales (no indexamos
//                                       contenido remoto en la V1).
//
// Hashtags: no soportados todavía (siempre devolvemos []).

const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../lib/authMiddleware');
const {
  serializeLocalAccount,
  serializeRemoteAccount,
  serializeLocalStatus,
} = require('../lib/serializers');
const { resolveRemoteActor, resolveActorByHandle } = require('../lib/remoteActors');
const { resolveOrFetchStatus } = require('../lib/statusResolver');

const router = express.Router();

function getInstanceDomain() {
  if (!process.env.INSTANCE_DOMAIN) {
    throw new Error('Falta la variable de entorno INSTANCE_DOMAIN.');
  }
  return process.env.INSTANCE_DOMAIN;
}

const ACCT_RE = /^@?([a-zA-Z0-9_.]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})$/;

function parseLimit(query) {
  const n = parseInt(query.limit, 10);
  if (Number.isNaN(n) || n <= 0) return 20;
  return Math.min(n, 40);
}

async function handleSearch(req, res) {
  const instanceDomain = getInstanceDomain();
  const q = (req.query.q || '').trim();
  const type = req.query.type; // 'accounts' | 'statuses' | 'hashtags' | undefined
  const resolve = req.query.resolve === 'true' || req.query.resolve === '1';
  const limit = parseLimit(req.query);

  const result = { accounts: [], statuses: [], hashtags: [] };
  if (!q) return res.json(result);

  try {
    // --- 1. URL: puede ser un Actor o un Status ajeno ---
    if (/^https?:\/\//i.test(q)) {
      if (!type || type === 'accounts') {
        try {
          const actorRow = await resolveRemoteActor(q);
          result.accounts.push(serializeRemoteAccount(actorRow));
        } catch {
          // No era un Actor válido — probamos como Status más abajo.
        }
      }
      if (result.accounts.length === 0 && (!type || type === 'statuses')) {
        const found = await resolveOrFetchStatus(q).catch(() => null);
        if (found && found.isRemote) {
          const actorRow = await pool.query(
            'SELECT * FROM remote_actors WHERE id = $1',
            [found.row.author_actor_id]
          );
          if (actorRow.rows[0]) {
            result.statuses.push({
              id: found.row.id,
              uri: found.row.activity_uri,
              url: found.row.activity_uri,
              created_at: new Date(found.row.received_at).toISOString(),
              account: serializeRemoteAccount(actorRow.rows[0]),
              content: found.row.content,
              visibility: found.row.visibility,
              sensitive: !!found.row.content_warning,
              spoiler_text: found.row.content_warning || '',
              media_attachments: [],
              mentions: [],
              tags: [],
              emojis: [],
              reblogs_count: 0,
              favourites_count: 0,
              replies_count: 0,
              favourited: false,
              reblogged: false,
              in_reply_to_id: null,
              in_reply_to_account_id: null,
              reblog: null,
              language: null,
            });
          }
        } else if (found && !found.isRemote) {
          const author = await pool.query('SELECT * FROM users WHERE id = $1', [found.row.author_id]);
          if (author.rows[0]) {
            result.statuses.push(serializeLocalStatus(found.row, author.rows[0], instanceDomain));
          }
        }
      }
      return res.json(result);
    }

    // --- 2. Handle "usuario@dominio" ---
    const acctMatch = q.match(ACCT_RE);
    if (acctMatch && (!type || type === 'accounts')) {
      const [, username, domain] = acctMatch;

      if (domain === instanceDomain) {
        const local = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (local.rows.length > 0) {
          result.accounts.push(serializeLocalAccount(local.rows[0], instanceDomain));
        }
        return res.json(result);
      }

      const cached = await pool.query(
        'SELECT * FROM remote_actors WHERE username = $1 AND domain = $2',
        [username, domain]
      );
      if (cached.rows.length > 0) {
        result.accounts.push(serializeRemoteAccount(cached.rows[0]));
      } else if (resolve) {
        try {
          const actorRow = await resolveActorByHandle(username, domain);
          result.accounts.push(serializeRemoteAccount(actorRow));
        } catch (err) {
          console.warn(`No se pudo resolver ${username}@${domain} por WebFinger: ${err.message}`);
        }
      }
      return res.json(result);
    }

    // --- 3. Texto libre: ILIKE local ---
    if (!type || type === 'accounts') {
      const localAccounts = await pool.query(
        `SELECT * FROM users
         WHERE username ILIKE $1 OR display_name ILIKE $1
         ORDER BY followers_count DESC LIMIT $2`,
        [`%${q}%`, limit]
      );
      result.accounts.push(...localAccounts.rows.map((u) => serializeLocalAccount(u, instanceDomain)));
    }

    if (!type || type === 'statuses') {
      if (!req.authUser) {
        // Mastodon exige login para buscar texto de statuses (evita
        // scraping anónimo de contenido); accounts sí puede ser público.
      } else {
        const localStatuses = await pool.query(
          `SELECT s.*, u.username, u.display_name, u.bio, u.created_at AS user_created_at,
                  u.followers_count, u.following_count, u.statuses_count, u.id AS user_id
           FROM statuses s JOIN users u ON u.id = s.author_id
           WHERE s.content ILIKE $1 AND s.visibility = 'public'
           ORDER BY s.created_at DESC LIMIT $2`,
          [`%${q}%`, limit]
        );
        result.statuses.push(
          ...localStatuses.rows.map((row) =>
            serializeLocalStatus(row, { ...row, id: row.user_id }, instanceDomain)
          )
        );
      }
    }

    return res.json(result);
  } catch (err) {
    console.error('Error en GET /api/v2/search:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
}

// Mastodon exige token para buscar (evita scraping anónimo, y Elk
// siempre manda uno cuando el usuario está logueado igual).
router.get('/api/v2/search', requireAuth, handleSearch);
router.get('/api/v1/search', requireAuth, handleSearch); // alias viejo, mismo shape

module.exports = router;