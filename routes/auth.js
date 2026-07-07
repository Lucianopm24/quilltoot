// routes/auth.js
//
// Registro y verificación de credenciales para usuarios LOCALES.
// El login "de verdad" para Elk pasa por OAuth (routes/oauth.js), que
// internamente llama a verifyCredentialsDetailed() de aquí.
//
// Dos controles independientes sobre el registro:
//  - OPEN_REGISTRATION: ¿cualquiera puede mandar POST /auth/register,
//    o solo un admin ya logueado puede crear cuentas? (desactivado por defecto)
//  - APPROVAL_REQUIRED: ¿la cuenta recién creada queda 'pending' hasta que
//    un admin la apruebe, o queda 'approved' de una? (ACTIVADO por defecto)
//
// Estos dos controles se combinan: puedes tener registro abierto pero con
// aprobación requerida (cualquiera se anota, pero un admin filtra quién entra),
// que es el modo recomendado para instancias pequeñas.

const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db/pool');
const { generateKeyPair } = require('../lib/keys');
const { attachUserIfPresent, requireAuth } = require('../lib/authMiddleware');
const { isApprovalRequired, isOpenRegistration } = require('../lib/registrationConfig');
const { getInstanceSettings, updateInstanceSettings, EDITABLE_FIELDS } = require('../lib/instanceSettings');

const router = express.Router();

// Resuelve req.authUser si viene un Bearer token, sin exigirlo — porque
// /auth/register a veces se llama sin login (primera cuenta / registro
// abierto) y a veces con login (admin creando cuentas con registro cerrado).
router.use(attachUserIfPresent);

const USERNAME_REGEX = /^[a-z0-9_]{1,30}$/;
const MIN_JOIN_REASON_LENGTH = 10;

/**
 * POST /auth/register
 * body: { username, email, password, display_name?, join_reason? }
 *
 * Reglas:
 *  - La PRIMERA cuenta que se crea en toda la instancia se vuelve admin
 *    automáticamente y queda 'approved' sin importar APPROVAL_REQUIRED
 *    (si no, nunca habría forma de arrancar la instancia).
 *  - Para cualquier cuenta siguiente:
 *      - Si OPEN_REGISTRATION=true -> cualquiera puede registrarse.
 *      - Si OPEN_REGISTRATION=false (o no está definida) -> solo un admin
 *        ya autenticado puede crear la cuenta.
 *      - Si APPROVAL_REQUIRED=true (default) -> se exige join_reason y la
 *        cuenta queda approval_status='pending' hasta que un admin la apruebe.
 *      - Si APPROVAL_REQUIRED=false -> la cuenta queda 'approved' de inmediato.
 */
router.post('/register', async (req, res) => {
  const { username, email, password, display_name, join_reason } = req.body || {};

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Faltan campos: username, email, password son obligatorios.' });
  }
  if (!USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: 'El username solo puede tener minúsculas, números y guion bajo, máximo 30 caracteres.',
    });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
  }

  try {
    const countResult = await pool.query('SELECT COUNT(*)::int AS total FROM users');
    const isFirstUser = countResult.rows[0].total === 0;

    const approvalRequired = isApprovalRequired();

    if (!isFirstUser) {
      if (!isOpenRegistration()) {
        // Requiere que quien llama sea un admin autenticado.
        if (!req.authUser || !req.authUser.is_admin) {
          return res.status(403).json({
            error: 'El registro está cerrado (OPEN_REGISTRATION=false). Solo un admin puede crear cuentas nuevas.',
          });
        }
      }

      if (approvalRequired && (!join_reason || join_reason.trim().length < MIN_JOIN_REASON_LENGTH)) {
        return res.status(400).json({
          error: `Esta instancia requiere una razón para unirse (mínimo ${MIN_JOIN_REASON_LENGTH} caracteres) en el campo join_reason.`,
        });
      }
    }

    const existing = await pool.query(
      'SELECT id FROM users WHERE username = $1 OR email = $2',
      [username, email]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Ese username o email ya está registrado.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const { publicKeyPem, privateKeyPem } = generateKeyPair();

    // La primera cuenta (admin) siempre 'approved'. Para el resto, depende
    // de APPROVAL_REQUIRED — si no se requiere aprobación, entra directo.
    const approvalStatus = isFirstUser || !approvalRequired ? 'approved' : 'pending';

    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash, display_name, public_key_pem, private_key_pem, is_admin, approval_status, join_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, username, display_name, is_admin, approval_status, created_at`,
      [username, email, passwordHash, display_name || username, publicKeyPem, privateKeyPem, isFirstUser, approvalStatus, join_reason || null]
    );

    const user = result.rows[0];
    const message =
      user.approval_status === 'pending'
        ? 'Cuenta creada. Un administrador debe aprobarla antes de que puedas iniciar sesión.'
        : 'Cuenta creada y aprobada.';

    return res.status(201).json({ user, message });
  } catch (err) {
    console.error('Error en /auth/register:', err);
    return res.status(500).json({ error: 'Error interno al crear el usuario.' });
  }
});

/**
 * GET /auth/admin/pending
 * Lista cuentas con approval_status = 'pending'. Solo un admin puede verla.
 */
router.get('/admin/pending', requireAuth, async (req, res) => {
  if (!req.authUser.is_admin) {
    return res.status(403).json({ error: 'Solo un admin puede ver las solicitudes pendientes.' });
  }
  try {
    const result = await pool.query(
      `SELECT id, username, email, display_name, join_reason, created_at
       FROM users WHERE approval_status = 'pending' ORDER BY created_at ASC`
    );
    return res.json({ pending: result.rows });
  } catch (err) {
    console.error('Error en GET /auth/admin/pending:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

/**
 * POST /auth/admin/:username/approve
 * POST /auth/admin/:username/reject
 * Solo un admin puede resolver una solicitud pendiente.
 */
async function resolveApproval(req, res, newStatus) {
  if (!req.authUser.is_admin) {
    return res.status(403).json({ error: 'Solo un admin puede aprobar o rechazar cuentas.' });
  }
  try {
    const result = await pool.query(
      `UPDATE users SET approval_status = $1, updated_at = now()
       WHERE username = $2 RETURNING id, username, approval_status`,
      [newStatus, req.params.username]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }
    return res.json({ user: result.rows[0] });
  } catch (err) {
    console.error(`Error resolviendo aprobación (${newStatus}):`, err);
    return res.status(500).json({ error: 'Error interno.' });
  }
}

router.post('/admin/:username/approve', requireAuth, (req, res) => resolveApproval(req, res, 'approved'));
router.post('/admin/:username/reject', requireAuth, (req, res) => resolveApproval(req, res, 'rejected'));

/**
 * GET /auth/admin/instance
 * PATCH /auth/admin/instance
 * body (PATCH): { title?, short_description?, description?, contact_email? }
 *
 * Permite al admin configurar lo que expone /api/v1/instance (título,
 * descripciones, email de contacto) sin tener que tocar código ni
 * redeployar. Solo se aceptan los campos en EDITABLE_FIELDS; cualquier
 * otra cosa en el body se ignora silenciosamente.
 */
router.get('/admin/instance', requireAuth, async (req, res) => {
  if (!req.authUser.is_admin) {
    return res.status(403).json({ error: 'Solo un admin puede ver la configuración de la instancia.' });
  }
  try {
    const settings = await getInstanceSettings();
    return res.json({ settings });
  } catch (err) {
    console.error('Error en GET /auth/admin/instance:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

router.patch('/admin/instance', requireAuth, async (req, res) => {
  if (!req.authUser.is_admin) {
    return res.status(403).json({ error: 'Solo un admin puede editar la configuración de la instancia.' });
  }
  const body = req.body || {};
  const receivedKeys = Object.keys(body);
  const unknownKeys = receivedKeys.filter((k) => !EDITABLE_FIELDS.includes(k));

  try {
    const settings = await updateInstanceSettings(body);
    return res.json({
      settings,
      ...(unknownKeys.length > 0 && {
        warning: `Estos campos no existen y se ignoraron: ${unknownKeys.join(', ')}. Campos válidos: ${EDITABLE_FIELDS.join(', ')}.`,
      }),
    });
  } catch (err) {
    console.error('Error en PATCH /auth/admin/instance:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

/**
 * POST /auth/admins/:username
 * Otorga (o quita) el rol de admin a otro usuario. Solo un admin puede llamarla.
 * body: { is_admin: true|false }
 */
router.post('/admins/:username', requireAuth, async (req, res) => {
  if (!req.authUser.is_admin) {
    return res.status(403).json({ error: 'Solo un admin puede otorgar o quitar el rol de admin.' });
  }

  const { is_admin } = req.body || {};
  if (typeof is_admin !== 'boolean') {
    return res.status(400).json({ error: 'El campo is_admin debe ser true o false.' });
  }

  try {
    const result = await pool.query(
      `UPDATE users SET is_admin = $1, updated_at = now() WHERE username = $2
       RETURNING id, username, is_admin`,
      [is_admin, req.params.username]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }
    return res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('Error en /auth/admins/:username:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

/**
 * Verifica username/email + password y devuelve un resultado detallado
 * que distingue "credenciales inválidas" de "cuenta pendiente/rechazada",
 * para que oauth.js pueda mostrar un mensaje claro en cada caso.
 *
 * @returns {Promise<{ok: true, user: object} | {ok: false, reason: 'invalid_credentials'|'pending_approval'|'rejected'}>}
 */
async function verifyCredentialsDetailed(identifier, password) {
  const result = await pool.query(
    'SELECT * FROM users WHERE username = $1 OR email = $1',
    [identifier]
  );
  const user = result.rows[0];
  if (!user) return { ok: false, reason: 'invalid_credentials' };

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return { ok: false, reason: 'invalid_credentials' };

  if (user.approval_status === 'pending') return { ok: false, reason: 'pending_approval' };
  if (user.approval_status === 'rejected') return { ok: false, reason: 'rejected' };

  delete user.password_hash;
  delete user.private_key_pem; // nunca sale de este módulo hacia afuera
  return { ok: true, user };
}

/**
 * Versión simple, mantenida por compatibilidad: devuelve el usuario o null.
 * OJO: esta versión NO distingue "pending"/"rejected" de "credenciales
 * inválidas" — usa verifyCredentialsDetailed en flujos donde ese detalle
 * importa (como OAuth).
 */
async function verifyCredentials(identifier, password) {
  const detailed = await verifyCredentialsDetailed(identifier, password);
  return detailed.ok ? detailed.user : null;
}

module.exports = { router, verifyCredentials, verifyCredentialsDetailed };