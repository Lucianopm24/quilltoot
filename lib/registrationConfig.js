// lib/registrationConfig.js
//
// Centraliza la lectura de las env vars que controlan el flujo de registro,
// para que auth.js, oauth.js y timelines.js lean siempre el mismo valor
// (evita que se desincronicen si cada archivo parsea el env por su cuenta).

/**
 * ¿Se requiere aprobación de un admin para que una cuenta nueva pueda
 * loguearse? Activado POR DEFECTO (a diferencia de OPEN_REGISTRATION,
 * que por defecto está cerrado). Para desactivarlo hay que poner
 * explícitamente APPROVAL_REQUIRED=false.
 */
function isApprovalRequired() {
  return String(process.env.APPROVAL_REQUIRED ?? 'true').toLowerCase() !== 'false';
}

/**
 * ¿Cualquiera puede registrarse sin que un admin cree la cuenta?
 * Desactivado por defecto (igual que antes).
 */
function isOpenRegistration() {
  return String(process.env.OPEN_REGISTRATION).toLowerCase() === 'true';
}

module.exports = { isApprovalRequired, isOpenRegistration };