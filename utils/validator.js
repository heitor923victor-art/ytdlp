/**
 * URL Validator — Sanitizes and validates YouTube URLs
 * Prevents command injection and invalid inputs
 */

const ALLOWED_DOMAINS = [
  'youtube.com',
  'www.youtube.com',
  'youtu.be',
  'm.youtube.com',
  'music.youtube.com',
];

const YOUTUBE_PATTERNS = [
  /^https?:\/\/(www\.)?youtube\.com\/watch\?v=[\w-]{11}/,
  /^https?:\/\/youtu\.be\/[\w-]{11}/,
  /^https?:\/\/(www\.)?youtube\.com\/shorts\/[\w-]{11}/,
  /^https?:\/\/(www\.)?youtube\.com\/playlist\?list=[\w-]+/,
  /^https?:\/\/music\.youtube\.com\/watch\?v=[\w-]{11}/,
];

/**
 * Validate that a URL is a legitimate YouTube URL
 * @param {string} url
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateURL(url) {
  if (!url || typeof url !== 'string') {
    return { valid: false, reason: 'URL não fornecida.' };
  }

  // Strip whitespace
  const trimmed = url.trim();

  // Length check (prevent absurdly long inputs)
  if (trimmed.length > 2048) {
    return { valid: false, reason: 'URL muito longa.' };
  }

  // Check for dangerous characters (command injection prevention)
  const dangerousChars = /[;&|`$<>{}[\]\\]/;
  if (dangerousChars.test(trimmed)) {
    return { valid: false, reason: 'URL contém caracteres inválidos.' };
  }

  // Must start with http/https
  if (!/^https?:\/\//i.test(trimmed)) {
    return { valid: false, reason: 'URL deve começar com http:// ou https://' };
  }

  // Parse URL
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, reason: 'URL malformada.' };
  }

  // Validate domain
  const hostname = parsed.hostname.toLowerCase();
  if (!ALLOWED_DOMAINS.includes(hostname)) {
    return { valid: false, reason: 'Apenas URLs do YouTube são suportadas.' };
  }

  // Validate pattern
  const matchesPattern = YOUTUBE_PATTERNS.some((pattern) => pattern.test(trimmed));
  if (!matchesPattern) {
    return { valid: false, reason: 'Link do YouTube inválido ou não suportado.' };
  }

  return { valid: true };
}

/**
 * Sanitize a filename to be safe for the filesystem
 * @param {string} name
 * @returns {string}
 */
function sanitizeFilename(name) {
  return name
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, '_')
    .replace(/__+/g, '_')
    .substring(0, 200);
}

module.exports = { validateURL, sanitizeFilename };
