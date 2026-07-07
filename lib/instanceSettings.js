// lib/instanceSettings.js
//
// Lee/actualiza la fila única de `instance_settings` (título, descripción,
// email de contacto) y calcula los stats reales que expone /api/v1/instance
// (antes estaban hardcodeados en el código, ahora salen de la DB).

const pool = require('../db/pool');

const EDITABLE_FIELDS = ['title', 'short_description', 'description', 'contact_email'];

/**
 * Trae la configuración de la instancia. Si por algo la fila no existiera
 * (ej. alguien corrió el schema antes de que existiera esta tabla y nunca
 * la sembró), la crea con los defaults de la tabla en vez de fallar.
 */
async function getInstanceSettings() {
  const result = await pool.query('SELECT * FROM instance_settings WHERE id = 1');
  if (result.rows.length > 0) return result.rows[0];

  const inserted = await pool.query(
    `INSERT INTO instance_settings (id) VALUES (1)
     ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
     RETURNING *`
  );
  return inserted.rows[0];
}

/**
 * Actualiza uno o más campos de la configuración. Solo acepta los campos
 * en EDITABLE_FIELDS — cualquier otra cosa en `fields` se ignora, para que
 * un admin no pueda colar columnas que no existen vía el body del request.
 */
async function updateInstanceSettings(fields) {
  const updates = Object.entries(fields || {}).filter(([key]) => EDITABLE_FIELDS.includes(key));
  if (updates.length === 0) {
    return getInstanceSettings();
  }

  const setClauses = updates.map(([key], i) => `${key} = $${i + 1}`);
  const values = updates.map(([, value]) => value);

  const result = await pool.query(
    `UPDATE instance_settings SET ${setClauses.join(', ')}, updated_at = now()
     WHERE id = 1 RETURNING *`,
    values
  );
  return result.rows[0];
}

/**
 * Calcula los stats reales que Mastodon/Elk esperan en /api/v1/instance:
 *  - user_count: cuentas locales existentes
 *  - status_count: posts locales publicados (no contamos los remotos
 *    federados, igual que Mastodon solo cuenta lo que es "tuyo")
 *  - domain_count: dominios remotos distintos con los que ya interactuaste
 */
async function getInstanceStats() {
  const [users, statuses, domains] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS c FROM users'),
    pool.query('SELECT COUNT(*)::int AS c FROM statuses'),
    pool.query('SELECT COUNT(DISTINCT domain)::int AS c FROM remote_actors'),
  ]);

  return {
    user_count: users.rows[0].c,
    status_count: statuses.rows[0].c,
    domain_count: domains.rows[0].c,
  };
}

module.exports = { getInstanceSettings, updateInstanceSettings, getInstanceStats, EDITABLE_FIELDS };