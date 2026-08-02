/**
 * Failure text from the transit pipeline is republished to an operator-configured
 * external issue tracker. Anything crossing that boundary must pass through here.
 */

const URL_PATTERN = /\b(?:https?|ftps?):\/\/[^\s"'`<>\\]+/gi;
const PATH_SECRET_SEGMENTS = new Set([
  "key",
  "keys",
  "apikey",
  "api-key",
  "api_key",
  "token",
  "access-token",
  "access_token",
  "secret",
  "auth",
]);
const BARE_CREDENTIAL_PATTERN =
  /((?<![\w-])(?:--)?(?:api[-_]?key|access[-_]?token|token|secret|password|passwd|auth|key)\b\s*[:=]\s*)(['"]?)(\[redacted\]|[^\s'"&,;)\]}]+)\2/gi;

function scrubPathKeys(pathname: string): string {
  const segments = pathname.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const preceding = segments[index - 1]?.toLowerCase();
    if (preceding && PATH_SECRET_SEGMENTS.has(preceding)) {
      segments[index] = "[redacted]";
    }
  }
  return segments.join("/");
}

export function scrubSecrets(message: string): string {
  if (typeof message !== "string" || message.length === 0) return message;

  let scrubbed = message.replace(URL_PATTERN, (raw) => {
    try {
      const parsed = new URL(raw);
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      parsed.pathname = scrubPathKeys(parsed.pathname);
      return parsed.toString();
    } catch {
      return "[url]";
    }
  });

  scrubbed = scrubbed.replace(
    /\b(Authorization\s*[:=]\s*)(?:Bearer|Basic|Token)\s+\S+/gi,
    "$1[redacted]",
  );
  scrubbed = scrubbed.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [redacted]");
  scrubbed = scrubbed.replace(BARE_CREDENTIAL_PATTERN, "$1$2[redacted]$2");
  scrubbed = scrubbed.replace(/AGE-ENCRYPTED:[A-Za-z0-9+/=]+/g, "AGE-ENCRYPTED:[redacted]");

  return scrubbed;
}

export function scrubSecretsOptional(message: string | undefined): string | undefined {
  return message === undefined ? undefined : scrubSecrets(message);
}
