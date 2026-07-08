// lib/api.js
//
// Cliente contra el backend real de Quilltoot. Nada acá inventa un
// endpoint que no exista en routes/ — todo apunta 1:1 a lo que el
// server ya expone.
//
// Detalle importante: Quilltoot NO tiene un endpoint de login directo
// (identifier + password -> token). El login "real" es el flujo OAuth
// de 3 pasos que usa Elk (POST /api/v1/apps -> GET/POST /oauth/authorize
// -> POST /oauth/token). loginWithPassword() hace esos 3 pasos por
// dentro, contra esta misma instancia, así la persona solo ve un
// formulario de usuario/contraseña — el panel actúa como su propia
// "app OAuth" de primera parte.

const TOKEN_KEY = 'quilltoot_panel_token';
const APP_KEY = 'quilltoot_panel_app_creds';

function getStoredToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function setStoredToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* localStorage puede no estar disponible; el panel sigue funcionando en memoria por esta sesión */
  }
}

function getStoredAppCreds() {
  try {
    const raw = localStorage.getItem(APP_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setStoredAppCreds(creds) {
  try {
    localStorage.setItem(APP_KEY, JSON.stringify(creds));
  } catch {
    /* ver nota arriba */
  }
}

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request(path, { method = 'GET', body, auth = true, headers = {} } = {}) {
  const finalHeaders = { 'Content-Type': 'application/json', ...headers };
  if (auth) {
    const token = getStoredToken();
    if (token) finalHeaders['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(path, {
    method,
    headers: finalHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!res.ok) {
    const message = data?.error || data?.error_description || `Error ${res.status}`;
    throw new ApiError(message, res.status, data);
  }
  return data;
}

/**
 * Registra (o recupera) las credenciales de "app OAuth" de este panel
 * contra la instancia. Solo hace falta una vez por navegador: se
 * guardan en localStorage y se reusan.
 */
async function ensureAppCreds() {
  const cached = getStoredAppCreds();
  if (cached?.client_id && cached?.client_secret) return cached;

  const redirectUri = `${window.location.origin}/panel/oauth-callback`;
  const data = await request('/api/v1/apps', {
    method: 'POST',
    auth: false,
    body: {
      client_name: 'Quilltoot Panel',
      redirect_uris: redirectUri,
      scopes: 'read write follow',
      website: window.location.origin,
    },
  });
  const creds = { client_id: data.client_id, client_secret: data.client_secret, redirect_uri: redirectUri };
  setStoredAppCreds(creds);
  return creds;
}

/**
 * Login con usuario/contraseña, escondiendo el flujo OAuth de 3 pasos
 * detrás de una sola llamada. Lanza ApiError con body.reason si la
 * cuenta está pending/rejected (oauth.js no distingue eso en la
 * respuesta HTML, así que replicamos la lógica acá contra el mismo
 * formulario POST /oauth/authorize).
 */
async function loginWithPassword(identifier, password) {
  const creds = await ensureAppCreds();

  const authorizeBody = new URLSearchParams({
    client_id: creds.client_id,
    redirect_uri: creds.redirect_uri,
    scope: 'read write follow',
    state: '',
    identifier,
    password,
  });

  // OJO: NO usar redirect:'manual' acá. fetch() con redirect:'manual'
  // devuelve una respuesta "opaque-redirect" — el navegador oculta
  // status Y headers por espec, así que leer el Location es imposible
  // aunque sea same-origin (esto rompía el login siempre, 100% de las
  // veces, no era intermitente). En su lugar, pedimos JSON explícito:
  // el backend (routes/oauth.js) detecta el header Accept y devuelve
  // { code } o { error } directo en el body, sin redirigir.
  const authorizeRes = await fetch('/oauth/authorize', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: authorizeBody.toString(),
  });

  let authorizeData;
  try {
    authorizeData = await authorizeRes.json();
  } catch {
    throw new ApiError('No se pudo iniciar sesión: respuesta inesperada del servidor.', authorizeRes.status);
  }

  if (!authorizeRes.ok || authorizeData.error) {
    throw new ApiError(authorizeData.error || 'No se pudo iniciar sesión.', authorizeRes.status);
  }

  const code = authorizeData.code;
  if (!code) {
    throw new ApiError('No se recibió un código de autorización.', 500);
  }

  const tokenData = await request('/oauth/token', {
    method: 'POST',
    auth: false,
    body: {
      grant_type: 'authorization_code',
      code,
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      redirect_uri: creds.redirect_uri,
    },
  });

  setStoredToken(tokenData.access_token);
  return tokenData;
}

function logout() {
  setStoredToken(null);
}

function isLoggedIn() {
  return !!getStoredToken();
}

// ------------------------------------------------------------
// Endpoints reales, agrupados
// ------------------------------------------------------------

const auth = {
  register: (body) => request('/auth/register', { method: 'POST', auth: false, body }),
  pending: () => request('/auth/admin/pending'),
  approve: (username) => request(`/auth/admin/${encodeURIComponent(username)}/approve`, { method: 'POST' }),
  reject: (username) => request(`/auth/admin/${encodeURIComponent(username)}/reject`, { method: 'POST' }),
  setAdmin: (username, isAdmin) =>
    request(`/auth/admins/${encodeURIComponent(username)}`, { method: 'POST', body: { is_admin: isAdmin } }),
};

const account = {
  verifyCredentials: () => request('/api/v1/accounts/verify_credentials'),
  get: (id) => request(`/api/v1/accounts/${id}`),
  statuses: (id) => request(`/api/v1/accounts/${id}/statuses`),
  follow: (id) => request(`/api/v1/accounts/${id}/follow`, { method: 'POST' }),
  unfollow: (id) => request(`/api/v1/accounts/${id}/unfollow`, { method: 'POST' }),
  block: (id) => request(`/api/v1/accounts/${id}/block`, { method: 'POST' }),
  unblock: (id) => request(`/api/v1/accounts/${id}/unblock`, { method: 'POST' }),
  mute: (id) => request(`/api/v1/accounts/${id}/mute`, { method: 'POST' }),
  unmute: (id) => request(`/api/v1/accounts/${id}/unmute`, { method: 'POST' }),
};

const instance = {
  get: () => request('/api/v1/instance', { auth: false }),
  getAdminSettings: () => request('/api/v1/admin/instance'),
  updateAdminSettings: (body) => request('/api/v1/admin/instance', { method: 'PATCH', body }),
};

const moderation = {
  searchAccounts: (q, status = 'all') =>
    request(`/api/v1/moderation/accounts?q=${encodeURIComponent(q || '')}&status=${status}`),
  suspend: (type, id, reason) =>
    request(`/api/v1/moderation/accounts/${type}/${id}/suspend`, { method: 'POST', body: { reason } }),
  unsuspend: (type, id) => request(`/api/v1/moderation/accounts/${type}/${id}/unsuspend`, { method: 'POST' }),
  silence: (type, id, reason) =>
    request(`/api/v1/moderation/accounts/${type}/${id}/silence`, { method: 'POST', body: { reason } }),
  unsilence: (type, id) => request(`/api/v1/moderation/accounts/${type}/${id}/unsilence`, { method: 'POST' }),
  listDomainBlocks: () => request('/api/v1/moderation/domain_blocks'),
  createDomainBlock: (body) => request('/api/v1/moderation/domain_blocks', { method: 'POST', body }),
  removeDomainBlock: (domain) =>
    request(`/api/v1/moderation/domain_blocks/${encodeURIComponent(domain)}`, { method: 'DELETE' }),
  listReports: (status = 'open') => request(`/api/v1/moderation/reports?status=${status}`),
  resolveReport: (id, action, note) =>
    request(`/api/v1/moderation/reports/${id}/resolve`, { method: 'POST', body: { action, note } }),
  setModerator: (userId, isModerator) =>
    request(`/api/v1/moderation/users/${userId}/role`, { method: 'PATCH', body: { is_moderator: isModerator } }),
  log: () => request('/api/v1/moderation/log'),
};

const reports = {
  create: (body) => request('/api/v1/reports', { method: 'POST', body }),
};

export const api = {
  loginWithPassword,
  logout,
  isLoggedIn,
  auth,
  account,
  instance,
  moderation,
  reports,
};

export { ApiError };