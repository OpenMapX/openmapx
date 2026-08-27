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
  "operator-feed",
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

function isAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(value);
}

/** Remove credentials, query, and fragment from absolute or request-relative URLs. */
export function scrubUrl(value: string): string {
  try {
    const absolute = isAbsoluteUrl(value);
    const parsed = new URL(value, "http://redaction.invalid");
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = scrubPathKeys(parsed.pathname);
    return absolute ? `${parsed.protocol}//${parsed.host}${parsed.pathname}` : parsed.pathname;
  } catch {
    return "[url]";
  }
}

export function scrubSecrets(message: string): string {
  if (typeof message !== "string" || message.length === 0) return message;

  let scrubbed = message.replace(URL_PATTERN, (raw) => {
    return scrubUrl(raw);
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

const EXACT_SECRET_FIELD_NAMES = new Set([
  "auth",
  "authorization",
  "cookie",
  "setcookie",
  "proxyauthorization",
  "accesskeyid",
  "privatekey",
]);

function isSecretFieldName(fieldName: string): boolean {
  const normalized = fieldName.replaceAll(/[-_]/g, "").toLowerCase();
  return (
    EXACT_SECRET_FIELD_NAMES.has(normalized) ||
    /(?:password|passwd|secret|token|apikey)$/.test(normalized)
  );
}

function scrubDiagnosticValueInner(
  value: unknown,
  seen: WeakMap<object, unknown>,
  fieldName?: string,
): unknown {
  if (fieldName && isSecretFieldName(fieldName)) return "[redacted]";
  if (typeof value === "string") {
    const normalizedFieldName = fieldName?.replaceAll(/[-_]/g, "").toLowerCase();
    return normalizedFieldName?.endsWith("url") ? scrubUrl(value) : scrubSecrets(value);
  }
  if (value === null || typeof value !== "object") return value;

  const existing = seen.get(value);
  if (existing !== undefined) return existing;

  if (value instanceof URL) return scrubSecrets(value.toString());
  if (value instanceof Date || ArrayBuffer.isView(value)) return value;

  // Fastify/Pino request serializers rely on object identity and hidden
  // symbols. Preserve the instance and redact the serializer's output later.
  if ("raw" in value && "id" in value && "log" in value) return value;

  if (value instanceof Error) {
    const scrubbed = new Error(scrubSecrets(value.message));
    seen.set(value, scrubbed);
    scrubbed.name = value.name;
    if (value.stack) scrubbed.stack = scrubSecrets(value.stack);
    if (value.cause !== undefined) {
      scrubbed.cause = scrubDiagnosticValueInner(value.cause, seen, "cause");
    }
    for (const [key, nested] of Object.entries(value)) {
      (scrubbed as unknown as Record<string, unknown>)[key] = scrubDiagnosticValueInner(
        nested,
        seen,
        key,
      );
    }
    return scrubbed;
  }

  if (Array.isArray(value)) {
    const scrubbed: unknown[] = [];
    seen.set(value, scrubbed);
    for (const nested of value) scrubbed.push(scrubDiagnosticValueInner(nested, seen));
    return scrubbed;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  const scrubbed: Record<string, unknown> = {};
  seen.set(value, scrubbed);
  for (const [key, nested] of Object.entries(value)) {
    scrubbed[key] = scrubDiagnosticValueInner(nested, seen, key);
  }
  return scrubbed;
}

/**
 * Return a scrubbed copy of JSON-shaped diagnostics without mutating the
 * caller's object. Error instances remain Error instances so Pino retains
 * their non-enumerable message, stack, and type.
 */
export function scrubDiagnosticValue(value: unknown): unknown {
  return scrubDiagnosticValueInner(value, new WeakMap());
}

export interface SafeUrlDiagnostic {
  protocol: string;
  host: string;
  path: string;
}

/** Strip URL credentials, query, and fragment while retaining safe routing context. */
export function safeUrlDiagnostic(rawUrl: string): SafeUrlDiagnostic | undefined {
  try {
    const parsed = new URL(scrubUrl(rawUrl));
    return {
      protocol: parsed.protocol,
      host: parsed.host,
      path: parsed.pathname,
    };
  } catch {
    return undefined;
  }
}
