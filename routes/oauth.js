// routes/oauth.js
//
// Implementa el flujo OAuth que Elk (y cualquier cliente Mastodon) espera:
//
//   1. POST /api/v1/apps            -> Elk se registra, recibe client_id/secret
//   2. GET  /oauth/authorize        -> Elk abre esto en el navegador; el usuario
//                                       mete usuario/contraseña y aprueba
//   3. POST /oauth/token            -> Elk intercambia el código (o directamente
//                                       usuario/contraseña, ver nota abajo) por
//                                       un access_token
//
// Nota sobre el "grant_type": Mastodon soporta tanto el flujo completo
// (authorization_code, con redirect) como un atajo password-grant-like
// para apps de primera parte. Elk SIEMPRE usa el flujo con redirect
// (authorization_code), así que es el que implementamos completo. El
// endpoint /oauth/authorize sirve el formulario de login+aprobación
// como HTML simple sin depender de ningún framework de frontend.

const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const { verifyCredentials } = require('./auth');

const router = express.Router();

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * `app.redirect_uris` se guarda como texto con una URI por línea (así se
 * definió en el schema, para soportar apps con más de un redirect posible).
 * Esta función valida que la URI recibida en la petición sea EXACTAMENTE
 * una de las registradas — sin esto, cualquiera podría registrar un
 * redirect_uri de mentira en /api/v1/apps y luego mandar uno distinto en
 * /oauth/authorize o /oauth/token para robarse el código o el token.
 */
function isRedirectUriAllowed(app, redirectUri) {
  if (!redirectUri) return false;
  const allowed = app.redirect_uris.split('\n').map((u) => u.trim()).filter(Boolean);
  return allowed.includes(redirectUri);
}

/**
 * POST /api/v1/apps
 * body: { client_name, redirect_uris, scopes?, website? }
 *
 * Cualquier cliente (Elk incluido) llama esto primero, sin login, para
 * obtener sus credenciales de app. Es el primer paso obligatorio de la
 * API de Mastodon antes de poder mostrar la pantalla de login.
 */
router.post('/api/v1/apps', async (req, res) => {
  const { client_name, redirect_uris, scopes, website } = req.body || {};

  if (!client_name || !redirect_uris) {
    return res.status(400).json({ error: 'Faltan client_name y redirect_uris.' });
  }

  try {
    const clientId = randomToken(16);
    const clientSecret = randomToken(32);
    const finalScopes = scopes || 'read write follow';

    await pool.query(
      `INSERT INTO oauth_apps (client_id, client_secret, name, redirect_uris, scopes, website)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [clientId, clientSecret, client_name, redirect_uris, finalScopes, website || null]
    );

    // Formato de respuesta que Mastodon (y por tanto Elk) espera exactamente.
    return res.status(200).json({
      id: clientId,
      name: client_name,
      website: website || null,
      redirect_uri: redirect_uris,
      client_id: clientId,
      client_secret: clientSecret,
      vapid_key: null, // no soportamos push notifications en la V1
    });
  } catch (err) {
    console.error('Error en POST /api/v1/apps:', err);
    return res.status(500).json({ error: 'Error interno al registrar la app.' });
  }
});

/**
 * GET /oauth/authorize
 * query: client_id, redirect_uri, response_type=code, scope, state?
 *
 * Sirve un formulario HTML simple de login. No usamos ningún framework
 * de frontend aquí: es una sola página autocontenida, suficiente porque
 * el usuario la ve UNA vez por app que autoriza (no es la UI del día a día,
 * esa la pone Elk).
 */
router.get('/oauth/authorize', async (req, res) => {
  const { client_id, redirect_uri, response_type, scope, state } = req.query;

  if (response_type !== 'code') {
    return res.status(400).send('Solo se soporta response_type=code.');
  }
  if (!client_id || !redirect_uri) {
    return res.status(400).send('Faltan client_id o redirect_uri.');
  }

  const appResult = await pool.query('SELECT * FROM oauth_apps WHERE client_id = $1', [client_id]);
  const app = appResult.rows[0];
  if (!app) {
    return res.status(404).send('App desconocida (client_id inválido). Registra la app primero con POST /api/v1/apps.');
  }
  if (!isRedirectUriAllowed(app, redirect_uri)) {
    return res.status(400).send('redirect_uri no coincide con ninguno de los registrados para esta app.');
  }

  // Formulario simple. Al enviarse, hace POST a esta misma ruta con los
  // mismos query params más username/password.
  const errorMsg = req.query.error ? `<p style="color:#c0392b">${req.query.error}</p>` : '';

  res.set('Content-Type', 'text/html; charset=utf-8');
  return res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="utf-8">
      <title>Autorizar ${app.name} — Quilltoot</title>
      <style>
        body { font-family: system-ui, sans-serif; background: #15161a; color: #e6e6e6; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .card { background: #1e1f24; padding: 2rem; border-radius: 12px; width: 320px; }
        h1 { font-size: 1.1rem; margin-bottom: 0.25rem; }
        p.sub { color: #9a9a9a; font-size: 0.9rem; margin-top: 0; }
        input { width: 100%; padding: 0.6rem; margin: 0.4rem 0; border-radius: 6px; border: 1px solid #333; background: #101114; color: #fff; box-sizing: border-box; }
        button { width: 100%; padding: 0.7rem; margin-top: 0.6rem; border: none; border-radius: 6px; background: #5b6ee1; color: white; font-weight: 600; cursor: pointer; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Autorizar ${app.name}</h1>
        <p class="sub">Inicia sesión en tu instancia Quilltoot para continuar.</p>
        ${errorMsg}
        <form method="POST" action="/oauth/authorize">
          <input type="hidden" name="client_id" value="${client_id}">
          <input type="hidden" name="redirect_uri" value="${redirect_uri}">
          <input type="hidden" name="scope" value="${scope || 'read write follow'}">
          <input type="hidden" name="state" value="${state || ''}">
          <input type="text" name="identifier" placeholder="Usuario o email" required>
          <input type="password" name="password" placeholder="Contraseña" required>
          <button type="submit">Autorizar</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

/**
 * POST /oauth/authorize
 * body: client_id, redirect_uri, scope, state, identifier, password
 *
 * Procesa el formulario de arriba: valida credenciales, genera un código
 * de autorización temporal, y redirige de vuelta a Elk con ese código.
 */
router.post('/oauth/authorize', express.urlencoded({ extended: true }), async (req, res) => {
  const { client_id, redirect_uri, scope, state, identifier, password } = req.body || {};

  const appResult = await pool.query('SELECT * FROM oauth_apps WHERE client_id = $1', [client_id]);
  const app = appResult.rows[0];
  if (!app) {
    return res.status(404).send('App desconocida.');
  }
  if (!isRedirectUriAllowed(app, redirect_uri)) {
    return res.status(400).send('redirect_uri no coincide con ninguno de los registrados para esta app.');
  }

  const user = await verifyCredentials(identifier, password);
  if (!user) {
    const qs = new URLSearchParams({ client_id, redirect_uri, response_type: 'code', scope, state: state || '', error: 'Usuario o contraseña incorrectos.' });
    return res.redirect(`/oauth/authorize?${qs.toString()}`);
  }

  const code = randomToken(24);
  await pool.query(
    `INSERT INTO oauth_auth_codes (code, app_id, user_id, redirect_uri, scopes)
     VALUES ($1, $2, $3, $4, $5)`,
    [code, app.id, user.id, redirect_uri, scope || 'read write follow']
  );

  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set('code', code);
  if (state) redirectUrl.searchParams.set('state', state);

  return res.redirect(redirectUrl.toString());
});

/**
 * POST /oauth/token
 * body: grant_type=authorization_code, code, client_id, client_secret, redirect_uri
 *
 * Intercambia el código de autorización por un access_token real.
 * Este es el paso final del login: después de esto, Elk guarda el
 * access_token y lo manda como "Authorization: Bearer <token>" en
 * cada request a la API.
 */
router.post('/oauth/token', express.urlencoded({ extended: true }), express.json(), async (req, res) => {
  const { grant_type, code, client_id, client_secret, redirect_uri } = req.body || {};

  if (grant_type !== 'authorization_code') {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }
  if (!code || !client_id || !client_secret) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'Faltan code, client_id o client_secret.' });
  }

  try {
    const appResult = await pool.query(
      'SELECT * FROM oauth_apps WHERE client_id = $1 AND client_secret = $2',
      [client_id, client_secret]
    );
    const app = appResult.rows[0];
    if (!app) {
      return res.status(401).json({ error: 'invalid_client' });
    }

    const codeResult = await pool.query(
      `SELECT * FROM oauth_auth_codes
       WHERE code = $1 AND app_id = $2 AND used = false AND expires_at > now()`,
      [code, app.id]
    );
    const authCode = codeResult.rows[0];
    if (!authCode) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Código inválido, expirado o ya usado.' });
    }
    // El redirect_uri de esta petición debe coincidir con el que se usó al
    // pedir el código (no basta con que esté en la lista general de la app:
    // debe ser el mismo exacto que se usó en /oauth/authorize).
    if (redirect_uri && authCode.redirect_uri !== redirect_uri) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri no coincide con el usado al generar el código.' });
    }
    if (!isRedirectUriAllowed(app, authCode.redirect_uri)) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri ya no está entre los registrados para esta app.' });
    }

    // Marcar el código como usado (de un solo uso, como exige el estándar OAuth)
    await pool.query('UPDATE oauth_auth_codes SET used = true WHERE code = $1', [code]);

    const accessToken = randomToken(32);
    await pool.query(
      `INSERT INTO oauth_tokens (access_token, app_id, user_id, scopes)
       VALUES ($1, $2, $3, $4)`,
      [accessToken, app.id, authCode.user_id, authCode.scopes]
    );

    // Formato exacto que espera un cliente Mastodon/Elk.
    return res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      scope: authCode.scopes,
      created_at: Math.floor(Date.now() / 1000),
    });
  } catch (err) {
    console.error('Error en POST /oauth/token:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;