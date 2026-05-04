import { createAuthMiddleware } from "better-auth/api";
import { writeAuditLog } from "./audit-log";

// Map admin-plugin endpoint paths to (action, target-type) tuples for audit
// emission. Keep keys aligned with better-auth's `admin` plugin route table —
// see node_modules/better-auth/dist/plugins/admin/admin.mjs.
const ADMIN_AUDIT_ROUTES: Record<string, { action: string; targetType: string }> = {
  "/admin/ban-user": { action: "user.ban", targetType: "user" },
  "/admin/unban-user": { action: "user.unban", targetType: "user" },
  "/admin/set-role": { action: "user.role.change", targetType: "user" },
  "/admin/impersonate-user": { action: "user.impersonate", targetType: "user" },
  "/admin/remove-user": { action: "user.delete", targetType: "user" },
  "/admin/create-user": { action: "user.create", targetType: "user" },
  "/admin/set-user-password": { action: "user.password.set", targetType: "user" },
  "/admin/revoke-user-session": { action: "user.session.revoke", targetType: "user" },
  "/admin/revoke-user-sessions": { action: "user.sessions.revoke_all", targetType: "user" },
};

interface AdminAuditBody {
  userId?: unknown;
  role?: unknown;
  banReason?: unknown;
  banExpiresIn?: unknown;
  email?: unknown;
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// `hooks.after` middleware for better-auth that records audit log entries
// for the admin-plugin user-management endpoints. The plugin handles those
// endpoints internally, so this is the only seam where we can observe them
// without forking the plugin.
export const auditAdminActionsHook = createAuthMiddleware(async (ctx) => {
  const route = ADMIN_AUDIT_ROUTES[ctx.path];
  if (!route) return;

  // Only audit successful operations. better-auth populates `context.returned`
  // for normal returns; thrown APIErrors do not reach here.
  const returned = ctx.context.returned;
  if (returned instanceof Error) return;

  const session = ctx.context.session;
  const actorId = session?.user?.id ?? null;

  const body = (ctx.body ?? {}) as AdminAuditBody;
  const targetId = pickString(body.userId) ?? null;

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
    targetType: route.targetType,
    action: route.action,
    details: Object.keys(details).length > 0 ? details : null,
    request: ctx.request as Parameters<typeof writeAuditLog>[0]["request"],
  });
});
