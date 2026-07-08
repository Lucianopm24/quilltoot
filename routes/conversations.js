// routes/conversations.js
//
// GET /api/v1/conversations — bandeja de mensajes directos que Elk
// muestra en su pestaña de DMs.
//
// Limitación conocida de la V1: Quilltoot no tiene una tabla de
// menciones (`mentions`), así que no sabemos de forma explícita
// quién es el destinatario de un post `visibility=direct` salvo por
// la cadena de respuestas. Por eso esta ruta arma "conversaciones"
// agrupando, por CADA hilo de statuses locales con visibility='direct'
// en el que el usuario autenticado participa (como autor de alguno de
// los mensajes, o como autor del mensaje raíz al que otro respondió),
// al otro participante — asumiendo conversación 1-a-1, que es el caso
// de uso principal de Elk. DMs remotos (con actores de otras
// instancias) no se listan todavía: eso necesita el módulo de
// menciones/federación de Create con `to` explícito, que queda para
// v2.

const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../lib/authMiddleware');
const { serializeLocalAccount, serializeLocalStatus } = require('../lib/serializers');

const router = express.Router();

function getInstanceDomain() {
  if (!process.env.INSTANCE_DOMAIN) {
    throw new Error('Falta la variable de entorno INSTANCE_DOMAIN.');
  }
  return process.env.INSTANCE_DOMAIN;
}

/**
 * Sube por la cadena in_reply_to_status_id hasta encontrar la raíz del
 * hilo. Con hilos cortos (típico en DMs) esto es barato; si algún día
 * hay hilos muy largos convendría una CTE recursiva en SQL en vez de
 * ir status por status.
 */
async function findThreadRootId(statusId) {
  let currentId = statusId;
  for (let i = 0; i < 50; i += 1) {
    const result = await pool.query('SELECT in_reply_to_status_id FROM statuses WHERE id = $1', [currentId]);
    const parentId = result.rows[0]?.in_reply_to_status_id;
    if (!parentId) return currentId;
    currentId = parentId;
  }
  return currentId; // corte de seguridad ante un ciclo improbable
}

/**
 * GET /api/v1/conversations
 */
router.get('/api/v1/conversations', requireAuth, async (req, res) => {
  const instanceDomain = getInstanceDomain();

  try {
    // Todos los DMs locales donde el usuario participa como autor.
    const myDirect = await pool.query(
      `SELECT * FROM statuses WHERE visibility = 'direct' AND author_id = $1`,
      [req.authUser.id]
    );
    // DMs locales que responden a un mensaje raíz cuyo autor es el usuario
    // (o sea: le escribieron a él/ella) — cubre el caso de ser destinatario.
    const repliesToMe = await pool.query(
      `SELECT s.* FROM statuses s
       JOIN statuses root ON root.id = s.in_reply_to_status_id
       WHERE s.visibility = 'direct' AND root.author_id = $1 AND s.author_id != $1`,
      [req.authUser.id]
    );

    const allMessages = [...myDirect.rows, ...repliesToMe.rows];
    if (allMessages.length === 0) return res.json([]);

    // Agrupar por raíz de hilo -> lista de mensajes del hilo.
    const threadsByRoot = new Map();
    for (const msg of allMessages) {
      const rootId = await findThreadRootId(msg.id);
      if (!threadsByRoot.has(rootId)) threadsByRoot.set(rootId, []);
      threadsByRoot.get(rootId).push(msg);
    }

    const conversations = [];
    for (const [rootId, messages] of threadsByRoot.entries()) {
      // El "último mensaje" del hilo es el más reciente que ya tenemos
      // cargado (puede no ser el hilo completo si hay ramas que no
      // involucran al usuario, pero para DMs 1-a-1 alcanza).
      const lastMessage = messages.reduce((a, b) => (new Date(a.created_at) > new Date(b.created_at) ? a : b));

      // El otro participante: quien no sea el usuario autenticado entre
      // el autor del último mensaje y el autor de la raíz.
      const rootResult = await pool.query('SELECT author_id FROM statuses WHERE id = $1', [rootId]);
      const rootAuthorId = rootResult.rows[0]?.author_id;
      const otherUserId = lastMessage.author_id !== req.authUser.id ? lastMessage.author_id : rootAuthorId;
      if (!otherUserId || otherUserId === req.authUser.id) continue; // conversación conmigo mismo: se omite

      const otherUser = await pool.query('SELECT * FROM users WHERE id = $1', [otherUserId]);
      if (otherUser.rows.length === 0) continue;

      const author = await pool.query('SELECT * FROM users WHERE id = $1', [lastMessage.author_id]);

      conversations.push({
        id: rootId,
        unread: lastMessage.author_id !== req.authUser.id, // aproximación: no tenemos read_at por mensaje
        accounts: [serializeLocalAccount(otherUser.rows[0], instanceDomain)],
        last_status: serializeLocalStatus(lastMessage, author.rows[0], instanceDomain),
      });
    }

    conversations.sort((a, b) => new Date(b.last_status.created_at) - new Date(a.last_status.created_at));
    return res.json(conversations);
  } catch (err) {
    console.error('Error en GET /api/v1/conversations:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

/**
 * DELETE /api/v1/conversations/:id
 * Mastodon la usa para "borrar" la conversación de la bandeja. No
 * borramos los statuses reales (eso es DELETE /api/v1/statuses/:id),
 * solo respondemos OK — Elk no vuelve a mostrarla si no encuentra el
 * status raíz en una carga posterior. Documentado como limitación: si
 * llegan mensajes nuevos al mismo hilo, va a reaparecer.
 */
router.delete('/api/v1/conversations/:id', requireAuth, async (req, res) => {
  return res.json({});
});

/**
 * POST /api/v1/conversations/:id/read
 */
router.post('/api/v1/conversations/:id/read', requireAuth, async (req, res) => {
  return res.json({});
});

module.exports = router;