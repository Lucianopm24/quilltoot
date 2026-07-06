// routes/auth.js
//
// Registro y verificación de credenciales para usuarios LOCALES.
// El login "de verdad" para Elk pasa por OAuth (routes/oauth.js), que
// internamente llama a verifyCredentials() de aquí. Esta ruta /auth/register
// existe para que tú (el dueño de la instancia) puedas crear cuentas,
// ya que por ahora no hay registro público abierto.

const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db/pool');
const { generateKeyPair } = require('../lib/keys');
const { attachUserIfPresent } = require('../lib/authMiddleware');

const router = express.Router();

// Resuelve req.authUser si viene un Bearer token, sin exigirlo — porque
// /auth/register a veces se llama sin login (primera cuenta / registro
// abierto) y a veces con login (admin creando cuentas con registro cerrado).
router.use(attachUserIfPresent);

const USERNAME_REGEX = /^[a-z0-9_]{1,30}$/;

/**
 * POST /auth/register
 * body: { username, email, password, display_name? }
 *
 * Reglas:
 *  - La PRIMERA cuenta que se crea en toda la instancia se vuelve admin
 *    automáticamente (sin importar el valor de OPEN_REGISTRATION, porque
 *    si no, nunca habría forma de arrancar la instancia).
 *  - Para cualquier cuenta siguiente:
 *      - Si OPEN_REGISTRATION=true -> cualquiera puede registrarse.
 *      - Si OPEN_REGISTRATION=false (o no está definida) -> solo un admin
 *        ya autenticado puede crear la cuenta (requiere header
 *        Authorization con un token OAuth válido de un usuario admin).
 */
router.post('/register', async (req, res) => {
  const { username, email, password, display_name } = req.body || {};

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

    if (!isFirstUser) {
      const openRegistration = String(process.env.OPEN_REGISTRATION).toLowerCase() === 'true';

      if (!openRegistration) {
        // Requiere que quien llama sea un admin autenticado.
        // req.authUser lo llena el middleware requireAuth (ver lib/authMiddleware.js).
        if (!req.authUser || !req.authUser.is_admin) {
          return res.status(403).json({
            error: 'El registro está cerrado (OPEN_REGISTRATION=false). Solo un admin puede crear cuentas nuevas.',
          });
        }
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

    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash, display_name, public_key_pem, private_key_pem, is_admin)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, username, display_name, is_admin, created_at`,
      [username, email, passwordHash, display_name || username, publicKeyPem, privateKeyPem, isFirstUser]
    );

    return res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    console.error('Error en /auth/register:', err);
    return res.status(500).json({ error: 'Error interno al crear el usuario.' });
  }
});

/**
 * POST /auth/admins/:username
 * Otorga (o quita) el rol de admin a otro usuario. Solo un admin puede llamarla.
 * body: { is_admin: true|false }
 */
router.post('/admins/:username', async (req, res) => {
  if (!req.authUser || !req.authUser.is_admin) {
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
 * Verifica username/email + password. Usado por el flujo OAuth cuando
 * Elk manda al usuario a la pantalla de login.
 *
 * @returns {Promise<object|null>} el usuario (sin password_hash) si es válido, o null
 */
async function verifyCredentials(identifier, password) {
  const result = await pool.query(
    'SELECT * FROM users WHERE username = $1 OR email = $1',
    [identifier]
  );
  const user = result.rows[0];
  if (!user) return null;

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return null;

  delete user.password_hash;
  delete user.private_key_pem; // nunca sale de este módulo hacia afuera
  return user;
}

module.exports = { router, verifyCredentials };