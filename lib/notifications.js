// lib/notifications.js
//
// Punto único para insertar filas en `notifications`. Lo importan
// follows.js (follow) y statuses.js (favourite, reblog, mention,
// reply) para no duplicar el INSERT en cada lugar donde ocurre un
// evento notificable.
//
// Reglas:
//   - Nunca notificamos a alguien de su propia acción (ej: yo me
//     favoriteo un post mío -> no genera notificación).
//   - El actor puede ser local o remoto; el destinatario SIEMPRE es
//     local (solo generamos notificaciones para gente de esta
//     instancia — un actor remoto ve sus notificaciones en SU propio
//     servidor).
//   - Si algo falla acá, no debe tumbar la acción principal (seguir,
//     favear, etc.) — se loguea el error y se sigue.

const pool = require('../db/pool');

/**
 * @param {object} params
 * @param {string} params.recipientUserId - dueño de la notificación (siempre local)
 * @param {'follow'|'follow_request'|'favourite'|'reblog'|'mention'|'reply'} params.type
 * @param {string|null} params.actorUserId - autor del evento, si es local
 * @param {string|null} params.actorActorId - autor del evento, si es remoto
 * @param {string|null} params.statusId - status local relacionado, si aplica
 * @param {string|null} params.remoteStatusId - status remoto relacionado, si aplica
 */
async function createNotification({
  recipientUserId,
  type,
  actorUserId = null,
  actorActorId = null,
  statusId = null,
  remoteStatusId = null,
}) {
  // No te notificamos de tus propias acciones sobre tus propios posts/cuenta.
  if (actorUserId && actorUserId === recipientUserId) return;

  try {
    await pool.query(
      `INSERT INTO notifications
         (recipient_user_id, type, actor_user_id, actor_actor_id, status_id, remote_status_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [recipientUserId, type, actorUserId, actorActorId, statusId, remoteStatusId]
    );
  } catch (err) {
    console.error(`Error creando notificación (type=${type}):`, err);
  }
}

module.exports = { createNotification };