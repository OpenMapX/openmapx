import { fromNodeHeaders } from "better-auth/node";
import type { FastifyRequest } from "fastify";
import { auth } from "../auth";
import { httpError } from "./http-error.js";
import { safeEqual } from "./safe-equal.js";

export type AdminSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

declare module "fastify" {
  interface FastifyRequest {
    adminSession?: AdminSession;
  }
}

/**
 * Returns the adminSession set by the preHandler hook.
 * Throws if it's missing (should never happen if requireAdmin preHandler is wired).
 */
export function getAdminSession(request: FastifyRequest): AdminSession {
  const s = request.adminSession;
  if (!s) throw new Error("adminSession not set — missing requireAdmin preHandler?");
  return s;
}

// Loopback addresses considered "same host". Admission also requires a local
// admin token (see `isLocalAdminRequest`). `::ffff:127.0.0.1` is the
// IPv4-mapped IPv6 form Node uses on dual-stack sockets.
//
// SECURITY NOTE: we deliberately read `request.socket.remoteAddress` here,
// NOT `request.ip`. With `trustProxy` enabled (the default for deployments
// behind Traefik), `request.ip` is derived from the X-Forwarded-For header
// and is therefore client-controllable. Any client could forge XFF to claim a
// loopback IP and gain admin access without auth. The socket peer address is
// always the actual TCP peer and cannot be spoofed by HTTP headers.
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function socketPeerAddress(request: FastifyRequest): string | undefined {
  return request.socket?.remoteAddress;
}

/**
 * Custom header that the CLI sets to prove it is a trusted local caller rather
 * than a malicious cross-origin form submission. HTML forms cannot set custom
 * headers, so requiring this header blocks localhost CSRF via `<form action>`.
 */
const LOCAL_ADMIN_TOKEN_HEADER = "x-openmapx-local-admin";

function getLocalAdminToken(): string | null {
  const token = process.env.OPENMAPX_LOCAL_ADMIN_TOKEN?.trim();
  return token ? token : null;
}

function isLocalAdminRequest(request: FastifyRequest): boolean {
  // Operator opt-out for multi-tenant hosts where loopback isn't a trust
  // boundary. Preserved for backwards compatibility.
  if (process.env.OPENMAPX_DISABLE_LOCALHOST_AUTH === "1") return false;
  const peer = socketPeerAddress(request);
  if (!peer || !LOOPBACK_ADDRESSES.has(peer)) return false;

  const header = request.headers[LOCAL_ADMIN_TOKEN_HEADER];
  const presented = Array.isArray(header) ? header[0] : header;
  const presentedString = typeof presented === "string" ? presented : "";

  const expected = getLocalAdminToken();

  // Dev default: when no token is configured, the developer workflow still
  // wants `pnpm openmapx ...` to work without provisioning a token. We keep
  // that, but require the request to carry the custom header — even with an
  // empty value — so a malicious site cannot CSRF the admin endpoints via a
  // simple `<form action="http://127.0.0.1:3001/api/admin/...">` POST. Custom
  // headers cannot be set on simple cross-origin requests without a CORS
  // preflight, which the API does not grant for admin routes.
  if (!expected) {
    if (process.env.NODE_ENV === "production") return false;
    return presented !== undefined; // header present (possibly empty) is enough.
  }

  if (!presentedString) return false;
  return safeEqual(presentedString, expected);
}

/**
 * Synthetic admin session emitted for loopback requests. The CLI uses this path
 * to call admin endpoints without needing to acquire session cookies first.
 *
 * Trust model: the request originates from a process on the same host as the
 * API. That process necessarily has at least the OS-level access of the API
 * itself, so the security boundary the admin endpoints represent is already
 * crossed. Operators on multi-tenant hosts (where the loopback assumption
 * doesn't hold) can opt out by setting `OPENMAPX_DISABLE_LOCALHOST_AUTH=1`.
 */
function loopbackSession(): AdminSession {
  return {
    user: {
      id: "loopback",
      role: "admin",
      // Other better-auth User fields are typed as required but unused by the
      // admin handlers; cast through `unknown` to satisfy the type system.
      name: "loopback",
      email: "loopback@localhost",
      emailVerified: true,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    session: {
      id: "loopback",
      userId: "loopback",
      token: "loopback",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      expiresAt: new Date(8.64e15),
      ipAddress: "127.0.0.1",
      userAgent: "openmapx-cli",
    },
  } as unknown as AdminSession;
}

type AdminResolution = { session: AdminSession } | { error: 401 | 403 };

/**
 * Resolve an admin session without touching the reply: loopback short-circuit
 * first, then the better-auth session + role check. Returns the failing status
 * code instead of sending, so both the throwing and non-throwing entry points
 * can share one code path.
 */
async function resolveAdmin(request: FastifyRequest, roles: string[]): Promise<AdminResolution> {
  if (isLocalAdminRequest(request)) return { session: loopbackSession() };

  const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  if (!session) return { error: 401 };
  if (!session.user.role || !roles.includes(session.user.role)) return { error: 403 };
  return { session: session as AdminSession };
}

/**
 * Require an active session with one of the allowed roles, returning the full
 * session (for audit logging) or throwing a 401/403 that Fastify's error
 * handler turns into the response. Throwing means a caller cannot forget to
 * `return reply` after a failed check.
 *
 * Loopback short-circuit: requests from `127.0.0.1` / `::1` are treated as
 * admin without further auth — the assumption is that anyone with localhost
 * shell access on the API host already has the same trust as the API itself.
 * Set `OPENMAPX_DISABLE_LOCALHOST_AUTH=1` to disable on multi-tenant hosts.
 *
 * @param roles - Roles that are allowed (default: ["admin"])
 */
export async function requireAdmin(
  request: FastifyRequest,
  roles: string[] = ["admin"],
): Promise<AdminSession> {
  const r = await resolveAdmin(request, roles);
  if ("error" in r) {
    throw r.error === 401
      ? httpError(401, "Authentication required")
      : httpError(403, "Admin access required");
  }
  return r.session;
}

/**
 * Non-throwing admin check for callers that must branch on the result rather
 * than abort the request (e.g. the data-manager proxy, which reports a denial
 * to its own caller). Returns the session or null; never sends or throws.
 */
export async function tryAdminSession(
  request: FastifyRequest,
  roles: string[] = ["admin"],
): Promise<AdminSession | null> {
  const r = await resolveAdmin(request, roles);
  return "error" in r ? null : r.session;
}
