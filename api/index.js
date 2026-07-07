// api/index.js
//
// Punto de entrada para Vercel. Vercel busca funciones serverless dentro
// de /api — cada archivo exporta un handler (aquí, la app de Express
// completa, que Vercel sabe envolver automáticamente).
//
// No hay lógica nueva acá: todo el server real vive en ../index.js
// (rutas, middlewares, federación). Este archivo solo lo reexporta para
// que Vercel lo encuentre donde lo espera.

module.exports = require('../index.js');