const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

/** Whether `value` is an absolute http(s) URL, the only kind an upstream link may carry. */
export function isSafeHttpUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function sanitizeUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return escapeHtml(url);
  return "";
}

const SAFE_HREF_SCHEME = /^(?:https?|mailto|tel):/i;

/**
 * Return `url` only if it is safe to place in an anchor `href`, else `undefined`.
 * Allows http(s), mailto, tel, and same-origin relative paths; rejects
 * `javascript:`, `data:`, `vbscript:`, `blob:`, `file:` and scheme-relative
 * `//host` URLs. Characters that browsers ignore when parsing a scheme (control
 * chars and zero-width spaces, e.g. in `java\tscript:`) are stripped first so
 * they cannot smuggle a dangerous scheme past the check.
 */
export function safeHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  let cleaned = "";
  for (const ch of url) {
    const code = ch.codePointAt(0) ?? 0;
    const isControl = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    const isZeroWidth = (code >= 0x200b && code <= 0x200d) || code === 0xfeff;
    if (!isControl && !isZeroWidth) cleaned += ch;
  }
  cleaned = cleaned.trim();
  if (!cleaned) return undefined;
  if (cleaned.startsWith("//")) return undefined;
  if (cleaned.startsWith("/")) return cleaned;
  return SAFE_HREF_SCHEME.test(cleaned) ? cleaned : undefined;
}
