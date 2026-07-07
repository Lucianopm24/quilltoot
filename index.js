// index.js
//
// Punto de entrada del servidor. Responsabilidades, en orden:
//
//   1. Cargar .env ANTES que cualquier otro require — db/pool.js lee
//      DATABASE_URL apenas se importa (revienta con un error claro si
//      falta), así que si dotenv no corrió primero, hasta un require
//      indirecto de cualquier ruta tira abajo el proceso.
//   2. Montar routes/inbox.js ANTES del parser JSON global: ese router
//      trae su PROPIO express.json() (con verify() para guardar
//      req.rawBody, imprescindible para validar el Digest de HTTP
//      Signatures). Si el parser global lo tocara primero, el body ya
//      vendría consumido y perderíamos el raw body.
//   3. Recién ahí, un express.json() global para el resto de las
//      rutas (auth, statuses, timelines, follows, moderation,
//      reports, admin), que asumen req.body ya parseado.
//   4. Montar cada router con el prefijo que le corresponde:
//        - webfinger, actor, oauth, statuses, timelines, follows,
//          moderation, reports: rutas absolutas (/api/v1/..., /users/...),
//          se montan en la raíz, SIN prefijo.
//        - auth: rutas relativas ('/register', '/admin/pending'...),
//          se monta bajo /auth.
//        - adminInstance: rutas relativas ('/instance'), se monta
//          bajo /api/v1/admin (así lo dejó documentado ese archivo).
//   5. Llamar a initFederation() ANTES de aceptar tráfico — conecta
//      los queueFederation(...) de statuses.js/follows.js con el
//      Outbox real (lib/federation.js). Si esto se olvida, todo sigue
//      funcionando localmente pero nada federa hacia afuera.
//
// CORS: Elk corre en un origen distinto al de esta API, así que hace
// falta habilitarlo a mano (no agregamos el paquete `cors` para no
// tocar package.json sin necesidad — son cuatro headers).

require('dotenv').config();

const express = require('express');

const inboxRouter = require('./routes/inbox');
const webfingerRouter = require('./routes/webfinger');
const actorRouter = require('./routes/actor');
const { router: authRouter } = require('./routes/auth');
const oauthRouter = require('./routes/oauth');
const adminInstanceRouter = require('./routes/adminInstance');
const { router: statusesRouter } = require('./routes/statuses');
const timelinesRouter = require('./routes/timelines');
const { router: followsRouter } = require('./routes/follows');
const moderationRouter = require('./routes/moderation');
const reportsRouter = require('./routes/reports');
const { initFederation } = require('./lib/federation');

const REQUIRED_ENV_VARS = ['DATABASE_URL', 'INSTANCE_DOMAIN'];
const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Faltan variables de entorno obligatorias: ${missing.join(', ')}. Revisá tu .env (ver .env.example).`);
  process.exit(1);
}

const app = express();

// Necesario detrás de un proxy (Vercel/Railway/Nginx) para que
// req.protocol/req.ip reflejen el cliente real y no el proxy.
app.set('trust proxy', true);

// CORS mínimo a mano: Elk (y cualquier otro cliente) necesita poder
// llamar a esta API desde un origen distinto. No restringimos por
// origin porque, a diferencia de una cookie de sesión, acá la
// autenticación es siempre un Bearer token explícito en el header.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

// --- Inbox PRIMERO, con su propio parser (ver nota arriba) ---
app.use(inboxRouter);

// --- Parser JSON global para todo lo demás ---
app.use(express.json());

// --- Federación (WebFinger + Actor): rutas absolutas, sin prefijo ---
app.use(webfingerRouter);
app.use(actorRouter);

// --- Auth: registro y aprobación de cuentas, bajo /auth ---
app.use('/auth', authRouter);

// --- OAuth (lo que usa Elk para loguearse): rutas absolutas ---
app.use(oauthRouter);

// --- Config de la instancia, solo admin, bajo /api/v1/admin ---
app.use('/api/v1/admin', adminInstanceRouter);

// --- API estilo Mastodon que Elk consume día a día ---
app.use(statusesRouter);
app.use(timelinesRouter);
app.use(followsRouter);

// --- Moderación (Módulo 7): panel de mods/admins + reportes de usuarios ---
app.use(moderationRouter);
app.use(reportsRouter);

// 404 explícito en JSON (mejor que el HTML default de Express para una API)
app.use((req, res) => {
  res.status(404).json({ error: `No existe ${req.method} ${req.path}` });
});

// Manejador de errores de último recurso: si algo revienta sin ser
// atrapado en su propia ruta, respondemos 500 en JSON en vez de tumbar
// el proceso o devolver un stack trace HTML al cliente.
app.use((err, req, res, next) => {
  console.error('Error no manejado:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Error interno.' });
});

initFederation();

// En Vercel (serverless) este archivo se importa como módulo — api/index.js
// reexporta `app` y Vercel maneja el "listen" por su cuenta. Solo abrimos
// un puerto propio cuando corremos localmente con `node index.js` / `npm start`.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Quilltoot escuchando en el puerto ${PORT} (INSTANCE_DOMAIN=${process.env.INSTANCE_DOMAIN})`);
  });
}

module.exports = app;