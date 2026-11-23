/**
 * Media URLs come from admin-editable text columns. Only an `https://` URL or
 * a site-relative path may reach pages, metadata and JSON-LD: `javascript:`,
 * `data:`, protocol-relative `//host` and anything with control characters are
 * dropped. (Images are rendered unoptimised, so `remotePatterns` restricts
 * nothing; this is the allowlist.)
 */
export function safeMediaUrl(url: string | null): string | null {
  if (url === null) return null;
  const value = url.trim();
  if (value === '' || /[\u0000-\u001f\u007f\\\s"'<>`]/.test(value)) return null;
  if (value.startsWith('/')) return value.startsWith('//') ? null : value;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname !== '' ? value : null;
  } catch {
    return null;
  }
}
