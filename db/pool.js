// db/pool.js
// Conexión a Postgres (Supabase). Usamos `pg` directo en vez del SDK de
// Supabase porque necesitamos SQL crudo para varias cosas de ActivityPub
// (JSONB, CHECK constraints complejos, etc.) y así el proyecto no queda
// atado a Supabase — cualquier Postgres (Neon, Railway, RDS...) sirve igual.

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'Falta la variable de entorno DATABASE_URL. ' +
    'En Supabase: Project Settings > Database > Connection string (modo "Transaction" o "Session").'
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase (y la mayoría de Postgres administrados) requieren SSL.
  // rejectUnauthorized: false porque Supabase usa certificados que Node
  // no siempre valida por defecto sin configuración extra.
  ssl: { rejectUnauthorized: false },
  max: 10,
});

pool.on('error', (err) => {
  console.error('Error inesperado en el pool de Postgres:', err);
});

module.exports = pool;