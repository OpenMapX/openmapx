import type { FastifyReply, FastifyRequest } from "fastify";
import { envString } from "./env.js";

const DEFAULT_WEB_ORIGIN = "http://localhost:3000";
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const CONFIGURATION_ERROR = "CORS_ORIGIN must contain only exact HTTP(S) origins";

/**
 * Parse an Origin-header serialization without accepting a URL path or other
 * URL components. URL is then used only for canonical scheme/host/port
 * normalization (including removal of default ports).
 */
export function normalizeHttpOrigin(value: string): string | null {
  if (/\p{Cc}|\s/u.test(value) || value.includes(",")) return null;

  const match = /^(https?):\/\/([^/?#]+)$/i.exec(value);
  if (!match) return null;
  const authority = match[2];
  if (
    !authority ||
    authority.includes("@") ||
    authority.includes("*") ||
    authority.includes("%") ||
    authority.endsWith(":")
  )
    return null;

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password || parsed.pathname !== "/") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function parseTrustedWebOrigins(value: string): [string, ...string[]] {
  const parts = value.split(",");
  if (parts.length === 0) throw new Error(CONFIGURATION_ERROR);

  const normalized = parts.map((part) => normalizeHttpOrigin(part.trim()));
  if (normalized.some((origin) => origin === null)) throw new Error(CONFIGURATION_ERROR);

  const origins = [...new Set(normalized as string[])];
  const first = origins[0];
  if (!first) throw new Error(CONFIGURATION_ERROR);
  return [first, ...origins.slice(1)];
}

export function configuredTrustedWebOrigins(): [string, ...string[]] {
  return parseTrustedWebOrigins(envString("CORS_ORIGIN", DEFAULT_WEB_ORIGIN));
}

/**
 * Better Auth owns CSRF checks only for its exact mount point. Avoid URL
 * normalization here: encoded separators and dot segments must not turn a
 * lookalike application path into an exemption.
 */
export function isBetterAuthCsrfPath(requestUrl: string): boolean {
  if (!requestUrl.startsWith("/") || requestUrl.startsWith("//")) return false;
  const queryIndex = requestUrl.indexOf("?");
  const pathname = queryIndex === -1 ? requestUrl : requestUrl.slice(0, queryIndex);
  if (pathname.includes("#") || pathname.includes("%") || pathname.includes("\\")) return false;
  if (pathname.split("/").some((segment) => segment === "." || segment === "..")) return false;
  return pathname === "/api/auth" || pathname.startsWith("/api/auth/");
}

function hasRawHeader(request: FastifyRequest, name: string): boolean {
  const lowerName = name.toLowerCase();
  const rawHeaders = request.raw.rawHeaders;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === lowerName) return true;
  }
  return Object.hasOwn(request.headers, lowerName);
}

function rawHeaderValues(request: FastifyRequest, name: string): string[] {
  const lowerName = name.toLowerCase();
  const values: string[] = [];
  const rawHeaders = request.raw.rawHeaders;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === lowerName) values.push(rawHeaders[index + 1] ?? "");
  }
  if (values.length > 0) return values;

  if (!Object.hasOwn(request.headers, lowerName)) return [];
  const value = request.headers[lowerName];
  return Array.isArray(value) ? value.map(String) : [String(value ?? "")];
}

export function makeCsrfGuardHook(trustedWebOrigins: readonly string[]) {
  const trusted = new Set(parseTrustedWebOrigins(trustedWebOrigins.join(",")));

  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!UNSAFE_METHODS.has(request.method)) return;
    if (isBetterAuthCsrfPath(request.url)) return;
    if (!hasRawHeader(request, "cookie")) return;

    const origins = rawHeaderValues(request, "origin");
    const normalized = origins.length === 1 ? normalizeHttpOrigin(origins[0] ?? "") : null;
    if (normalized !== null && trusted.has(normalized)) return;

    await reply.status(403).send({ error: "Forbidden" });
  };
}
