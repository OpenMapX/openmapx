export interface UrlWithoutCredentials {
  /** The URL without its user info. */
  url: string;
  /** A Basic `Authorization` header value for the removed credentials. */
  authorization?: string;
  /** The removed values, decoded and as written, for redacting them from text. */
  secrets: string[];
}

/** Base64 of the text's UTF-8 bytes, as Basic authorization encodes credentials. */
function base64Utf8(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Move a URL's user info (`https://user:pass@host`) into a Basic
 * authorization header. `fetch` refuses a URL carrying credentials and names
 * the whole URL, password included, in its error. A string that is not a URL
 * is returned unchanged.
 */
export function urlCredentialsAsBasicAuth(url: string): UrlWithoutCredentials {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, secrets: [] };
  }
  if (!parsed.username && !parsed.password) return { url, secrets: [] };
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  const secrets = [user, password, parsed.username, parsed.password].filter(Boolean);
  parsed.username = "";
  parsed.password = "";
  return {
    url: parsed.href,
    authorization: `Basic ${base64Utf8(`${user}:${password}`)}`,
    secrets: [...new Set(secrets)],
  };
}
