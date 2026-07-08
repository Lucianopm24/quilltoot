// lib/serializers.js
//
// Convierte nuestras filas de la base de datos (statuses, remote_statuses,
// users, remote_actors) al formato JSON exacto que Elk/Mastodon esperan.
// Centralizar esto evita que cada ruta invente su propio shape y se
// desincronice de lo que Elk necesita.

/**
 * Serializa un usuario LOCAL como "Account" (formato Mastodon).
 */
function serializeLocalAccount(user, instanceDomain) {
  return {
    id: user.id,
    username: user.username,
    acct: user.username, // en Mastodon, acct es sin dominio para cuentas locales
    display_name: user.display_name || user.username,
    locked: false,
    bot: false,
    created_at: user.created_at ? new Date(user.created_at).toISOString() : new Date().toISOString(),
    note: user.bio || '',
    url: `https://${instanceDomain}/@${user.username}`,
    avatar: '', // no manejamos avatares en la V1
    avatar_static: '',
    header: '',
    header_static: '',
    followers_count: user.followers_count ?? 0,
    following_count: user.following_count ?? 0,
    statuses_count: user.statuses_count ?? 0,
    fields: [],
    emojis: [],
  };
}

/**
 * Serializa un actor REMOTO (de otra instancia) como "Account".
 *
 * avatar/header/note no vivían como columnas propias — pero sí tenemos
 * el documento Actor COMPLETO cacheado en raw_actor_json (ver
 * lib/remoteActors.js), que ya trae icon/image/summary tal como los
 * define ActivityPub. Antes esta función los ignoraba y mandaba
 * strings vacíos siempre, por eso ni la foto de perfil ni la portada
 * de cuentas remotas cargaban nunca en Elk.
 */
function serializeRemoteAccount(actor) {
  const raw = actor.raw_actor_json || {};

  // icon/image pueden venir como un objeto {url,...} o, más raro, como
  // un array de esos objetos (algunos servidores lo hacen así) — nos
  // quedamos con el primero que tenga url en cualquiera de los casos.
  const pickUrl = (value) => {
    if (!value) return '';
    const candidate = Array.isArray(value) ? value[0] : value;
    return candidate?.url || '';
  };

  const avatarUrl = pickUrl(raw.icon);
  const headerUrl = pickUrl(raw.image);

  return {
    id: actor.id,
    username: actor.username,
    acct: `${actor.username}@${actor.domain}`, // en Mastodon, acct SIEMPRE incluye dominio para remotos
    display_name: actor.display_name || actor.username,
    locked: false,
    bot: false,
    created_at: actor.fetched_at ? new Date(actor.fetched_at).toISOString() : new Date().toISOString(),
    note: raw.summary || '',
    url: actor.actor_uri,
    avatar: avatarUrl,
    avatar_static: avatarUrl,
    header: headerUrl,
    header_static: headerUrl,
    followers_count: 0,
    following_count: 0,
    statuses_count: 0,
    fields: [],
    emojis: [],
  };
}

/**
 * Serializa un status LOCAL (siempre solo texto, sin adjuntos) como "Status".
 *
 * @param {object} status - fila de la tabla `statuses`
 * @param {object} author - fila de `users` (el autor)
 * @param {object} extra - { favourited, reblogged, favourites_count, reblogs_count }
 */
function serializeLocalStatus(status, author, instanceDomain, extra = {}) {
  return {
    id: status.id,
    uri: status.activity_uri,
    url: status.activity_uri,
    created_at: new Date(status.created_at).toISOString(),
    account: serializeLocalAccount(author, instanceDomain),
    content: status.content,
    visibility: status.visibility,
    sensitive: !!status.content_warning,
    spoiler_text: status.content_warning || '',
    media_attachments: [], // los usuarios locales NUNCA adjuntan imágenes en Quilltoot
    mentions: [],
    tags: [],
    emojis: [],
    reblogs_count: extra.reblogs_count ?? 0,
    favourites_count: extra.favourites_count ?? 0,
    replies_count: extra.replies_count ?? 0,
    favourited: !!extra.favourited,
    reblogged: !!extra.reblogged,
    in_reply_to_id: status.in_reply_to_status_id || status.in_reply_to_remote_id || null,
    in_reply_to_account_id: null,
    reblog: null,
    language: null,
  };
}

/**
 * Serializa un status REMOTO (puede traer adjuntos tal como vinieron
 * federados desde otra instancia).
 */
function serializeRemoteStatus(remoteStatus, actor, extra = {}) {
  const attachments = Array.isArray(remoteStatus.attachments) ? remoteStatus.attachments : [];

  return {
    id: remoteStatus.id,
    uri: remoteStatus.activity_uri,
    url: remoteStatus.activity_uri,
    created_at: new Date(remoteStatus.received_at).toISOString(),
    account: serializeRemoteAccount(actor),
    content: remoteStatus.content,
    visibility: remoteStatus.visibility,
    sensitive: !!remoteStatus.content_warning,
    spoiler_text: remoteStatus.content_warning || '',
    // Reflejamos los adjuntos tal como llegaron del servidor de origen.
    // No los procesamos ni re-hosteamos, solo pasamos la URL/metadata.
    media_attachments: attachments.map((att, idx) => ({
      id: `${remoteStatus.id}-media-${idx}`,
      type: att.type && att.type.startsWith('image') ? 'image' : 'unknown',
      url: att.url,
      preview_url: att.url,
      description: att.description || null,
    })),
    mentions: [],
    tags: [],
    emojis: [],
    reblogs_count: extra.reblogs_count ?? 0,
    favourites_count: extra.favourites_count ?? 0,
    replies_count: 0,
    favourited: !!extra.favourited,
    reblogged: !!extra.reblogged,
    in_reply_to_id: null,
    in_reply_to_account_id: null,
    reblog: null,
    language: null,
  };
}

module.exports = {
  serializeLocalAccount,
  serializeRemoteAccount,
  serializeLocalStatus,
  serializeRemoteStatus,
};