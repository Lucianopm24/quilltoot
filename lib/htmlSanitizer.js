// lib/htmlSanitizer.js
//
// El schema (remote_statuses.content) dice "HTML tal como vino (ya
// sanitizado)", pero esa sanitización nunca se implementó — eso significa
// que hoy mismo guardaríamos <script> de cualquier instancia remota tal
// cual y Elk lo renderizaría sin cuestionarlo. Esto es un allowlist
// simple (no un parser HTML completo): alcanza para el HTML que
// Mastodon/Pleroma/etc. realmente producen en el campo `content` de una
// Note (párrafos, saltos de línea, links de mención/hashtag).
//
// No usamos ninguna librería (sanitize-html, DOMPurify...) para no sumar
// una dependencia nueva solo por esto; si el proyecto crece y necesita
// cubrir más casos, ahí sí valdría la pena migrar a una librería real.

const ALLOWED_TAGS = new Set(['p', 'br', 'a', 'span', 'b', 'i', 'strong', 'em', 'ul', 'ol', 'li', 'blockquote']);

const SAFE_URL_SCHEME = /^(https?:)?\/\//i;

/**
 * Sanitiza HTML federado antes de guardarlo en remote_statuses.content.
 *
 * Estrategia (allowlist estricta, no intenta "arreglar" HTML mal formado):
 *   1. Elimina por completo <script>, <style> y cualquier comentario HTML,
 *      incluyendo su contenido.
 *   2. Elimina cualquier tag que no esté en ALLOWED_TAGS.
 *   3. De los tags permitidos, elimina TODOS los atributos excepto
 *      `href` en <a> (y solo si es http/https, para evitar javascript:,
 *      data:, etc.)
 */
function sanitizeHtml(rawHtml) {
  if (typeof rawHtml !== 'string' || !rawHtml) return '';

  let html = rawHtml
    // Fuera scripts/estilos con su contenido completo
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Fuera comentarios HTML (pueden usarse para exfiltrar cosas raras)
    .replace(/<!--[\s\S]*?-->/g, '');

  // Reconstruimos tag por tag, permitiendo solo lo que está en el allowlist.
  html = html.replace(/<\/?([a-zA-Z0-9]+)([^>]*)>/g, (fullMatch, tagName, attrsRaw) => {
    const tag = tagName.toLowerCase();
    const isClosing = fullMatch.startsWith('</');

    if (!ALLOWED_TAGS.has(tag)) {
      return ''; // tag no permitido: se elimina (incluye <img>, <div>, <iframe>, etc.)
    }

    if (isClosing) {
      return `</${tag}>`;
    }

    if (tag === 'a') {
      const hrefMatch = attrsRaw.match(/href\s*=\s*["']([^"']*)["']/i);
      const href = hrefMatch ? hrefMatch[1] : null;
      if (href && SAFE_URL_SCHEME.test(href)) {
        // rel="nofollow noopener" por higiene, igual que hace Mastodon
        return `<a href="${href.replace(/"/g, '&quot;')}" rel="nofollow noopener">`;
      }
      return '<a>'; // link sin href válido: se conserva el texto, no el destino
    }

    // br es self-closing y no acarrea atributos útiles para nosotros
    return `<${tag}>`;
  });

  return html;
}

module.exports = { sanitizeHtml };