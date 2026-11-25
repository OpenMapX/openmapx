import type { AuditAction } from "@openmapx/core/api-contracts";
import { currentAccountMutation } from "../account/account-context";
import { writeAuditLog } from "./audit-log";

// Map admin-plugin endpoint paths to the audit actions they record. Keep keys
// aligned with better-auth's `admin` plugin route table — see
// node_modules/better-auth/dist/plugins/admin/admin.mjs.
const ADMIN_AUDIT_ROUTES: Record<string, { action: AuditAction }> = {
  "/admin/ban-user": { action: "user.ban" },
  "/admin/unban-user": { action: "user.unban" },
  "/admin/set-role": { action: "user.role.change" },
  "/admin/impersonate-user": { action: "user.impersonate" },
  "/admin/remove-user": { action: "user.delete" },
  "/admin/create-user": { action: "user.create" },
  "/admin/set-user-password": { action: "user.password.set" },
  "/admin/revoke-user-session": { action: "user.session.revoke" },
  "/admin/revoke-user-sessions": { action: "user.session.revoke_all" },
};

interface AdminAuditBody {
  userId?: unknown;
  role?: unknown;
  banReason?: unknown;
  banExpiresIn?: unknown;
  email?: unknown;
}

// Minimal structural view of the better-auth middleware context that the audit
// emitter reads. Declared explicitly so the emitter can be unit-tested with a
// plain object instead of a full better-auth endpoint context.
export interface AdminAuditCtx {
  path: string;
  body?: unknown;
  request?: Parameters<typeof writeAuditLog>[0]["request"];
  context: {
    returned?: unknown;
    session?: { user?: { id?: string | null } | null } | null;
  };
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Records an audit log entry for the admin-plugin user-management endpoints.
// The `hooks.after` middleware in auth.ts calls it with the real better-auth
// context; the plugin handles those endpoints internally, so that hook is the
// only seam where they can be observed without forking the plugin.
export async function handleAdminAuditEvent(ctx: AdminAuditCtx): Promise<void> {
  if (ctx.path === "/admin/set-user-password" && currentAccountMutation()?.action === "password")
    return;
  if (ctx.path === "/admin/set-role" && currentAccountMutation()?.roleAudit) return;
  const route = ADMIN_AUDIT_ROUTES[ctx.path];
  if (!route) return;

  // Only audit successful operations. better-auth populates `context.returned`
  // for normal returns; thrown APIErrors do not reach here.
  const returned = ctx.context.returned;
  if (returned instanceof Error) return;

  const session = ctx.context.session;
  const actorId = session?.user?.id ?? null;

  const body = (ctx.body ?? {}) as AdminAuditBody;
  // The deletion receipt lives in the pseudonymous erasure journal. Retaining
  // the raw deleted user id here would recreate personal data after cleanup.
  const targetId = route.action === "user.delete" ? null : (pickString(body.userId) ?? null);

  const details: Record<string, unknown> = {};
  if (route.action === "user.role.change") {
    const role = pickString(body.role);
    if (role) details.role = role;
  } else if (route.action === "user.ban") {
    const reason = pickString(body.banReason);
    if (reason) details.reason = reason;
    if (typeof body.banExpiresIn === "number") {
      details.expiresIn = body.banExpiresIn;
    }
  } else if (route.action === "user.create") {
    const email = pickString(body.email);
    if (email) details.email = email;
    const role = pickString(body.role);
    if (role) details.role = role;
  }

  await writeAuditLog({
    actorId,
    targetId,
    action: route.action,
    details: Object.keys(details).length > 0 ? details : null,
    request: ctx.request,
  });
}
