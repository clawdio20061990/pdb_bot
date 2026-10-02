/** Escape text for Telegram HTML parse mode (also safe inside double-quoted attributes). */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Only http(s) links are allowed into <a href>. */
export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function link(text: string, url: string | null | undefined): string {
  const href = safeUrl(url);
  return href ? `<a href="${esc(href)}">${esc(text)}</a>` : esc(text);
}

/** Truncate by code points (never splits an emoji / surrogate pair — broken pairs are invalid in jsonb). */
export function cut(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

/** Shorten PLAIN text (before escaping — clipping HTML could cut a tag in half). */
export function clip(text: string, max: number): string {
  return Array.from(text).length <= max ? text : `${cut(text, max - 1).trimEnd()}…`;
}

/** Best-effort plain-text version of a Telegram-HTML message (fallback when Telegram rejects the markup). */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}
