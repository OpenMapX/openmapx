import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import type { Command } from "commander";

/** Operator-owned credentials and receipts; never discovers browser stores. */
export function readPrivateOperatorFile(path: string, maximum: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const a = fstatSync(fd);
    if (
      !a.isFile() ||
      a.nlink !== 1 ||
      a.uid !== process.geteuid?.() ||
      (a.mode & 0o077) !== 0 ||
      a.size < 1 ||
      a.size > maximum
    )
      throw Error("Unsafe private file");
    const bytes = Buffer.alloc(a.size);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, null);
      if (!count) throw Error("Private file changed");
      used += count;
    }
    const b = fstatSync(fd),
      named = lstatSync(path);
    if (
      a.dev !== b.dev ||
      a.ino !== b.ino ||
      a.size !== b.size ||
      a.mtimeMs !== b.mtimeMs ||
      a.ctimeMs !== b.ctimeMs ||
      b.ino !== named.ino ||
      b.dev !== named.dev ||
      named.isSymbolicLink()
    )
      throw Error("Private file changed");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    closeSync(fd);
  }
}
/** A refused session file or API origin; its message is fixed text, safe to print. */
export class AdminSessionError extends Error {}

export function readAdminSessionFile(path: string): string {
  try {
    const cookie = readPrivateOperatorFile(path, 16 * 1024).trim();
    if (!/^(?:__Secure-)?better-auth\.session_token=[A-Za-z0-9._~%+/=-]{1,16000}$/.test(cookie))
      throw Error("Invalid cookie");
    return cookie;
  } catch {
    throw new AdminSessionError(
      "Admin session file must contain only a Better Auth session cookie, owned by this user, mode 0600 and one link",
    );
  }
}
/** How a host command reaches the API as the operator's administrator session. */
export interface AdminSessionOptions {
  /** HTTPS origin; defaults to `https://DOMAIN`. */
  apiOrigin?: string;
  sessionFile: string;
  allowLoopbackHttp?: boolean;
}

/**
 * The API origin and the headers that authenticate a request there as the
 * operator's administrator session. The session cookie is meant for that exact
 * origin only, so every caller refuses redirects.
 */
export function adminSessionRequest(options: AdminSessionOptions): {
  origin: string;
  headers: { cookie: string; origin: string };
} {
  const origin = adminApiOrigin(options.apiOrigin, process.env.DOMAIN, options.allowLoopbackHttp);
  return { origin, headers: { cookie: readAdminSessionFile(options.sessionFile), origin } };
}

/** The options of every command that acts as the administrator session. */
export function withAdminSessionOptions(command: Command): Command {
  return command
    .requiredOption(
      "--session-file <path>",
      "Operator-provided mode-0600 Better Auth session-cookie file",
    )
    .option("--api-origin <origin>", "HTTPS API origin (default: https://DOMAIN)")
    .option("--allow-loopback-http", "Allow HTTP only to a loopback origin for development");
}

export function adminApiOrigin(input?: string, domain?: string, allowLoopbackHttp = false): string {
  if (input === undefined && !domain)
    throw new AdminSessionError("Set DOMAIN in infra/docker/.env or pass --api-origin");
  let url: URL;
  try {
    url = new URL(input ?? `https://${domain}`);
  } catch {
    throw new AdminSessionError("Use an HTTPS API origin without credentials, path or query");
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        allowLoopbackHttp &&
        url.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
      ))
  )
    throw new AdminSessionError("Use an HTTPS API origin without credentials, path or query");
  return url.origin;
}
