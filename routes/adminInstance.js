// routes/adminInstance.js
//
// Endpoints de administración para configurar lo que expone
// /api/v1/instance (título, descripciones, email de contacto) sin tener
// que tocar código ni redeployar. Está separado de auth.js y se monta
// bajo /api/v1/admin porque es parte de la superficie de la API estilo
// Mastodon, no del flujo de registro/login.

const express = require('express');
const { requireAuth } = require('../lib/authMiddleware');
const { getInstanceSettings, updateInstanceSettings, EDITABLE_FIELDS } = require('../lib/instanceSettings');

const router = express.Router();

/**
 * GET /api/v1/admin/instance
 * Ver la configuración actual. Solo un admin.
 */
router.get('/instance', requireAuth, async (req, res) => {
  if (!req.authUser.is_admin) {
    return res.status(403).json({ error: 'Solo un admin puede ver la configuración de la instancia.' });
  }
  try {
    const settings = await getInstanceSettings();
    return res.json({ settings });
  } catch (err) {
    console.error('Error en GET /api/v1/admin/instance:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

/**
 * PATCH /api/v1/admin/instance
 * body: { title?, short_description?, description?, contact_email? }
 *
 * Solo se aceptan los campos en EDITABLE_FIELDS; cualquier otra cosa en
 * el body se ignora (con un warning en la respuesta) en vez de fallar.
 */
router.patch('/instance', requireAuth, async (req, res) => {
  if (!req.authUser.is_admin) {
    return res.status(403).json({ error: 'Solo un admin puede editar la configuración de la instancia.' });
  }
  const body = req.body || {};
  const unknownKeys = Object.keys(body).filter((k) => !EDITABLE_FIELDS.includes(k));

  try {
    const settings = await updateInstanceSettings(body);
    return res.json({
      settings,
      ...(unknownKeys.length > 0 && {
        warning: `Estos campos no existen y se ignoraron: ${unknownKeys.join(', ')}. Campos válidos: ${EDITABLE_FIELDS.join(', ')}.`,
      }),
    });
  } catch (err) {
    console.error('Error en PATCH /api/v1/admin/instance:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

module.exports = router;