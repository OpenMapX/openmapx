import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./audit-log.js", () => ({ writeAuditLog: vi.fn() }));

import { writeAuditLog } from "./audit-log.js";
import { type AdminAuditCtx, handleAdminAuditEvent } from "./auth-audit-hook.js";

const write = vi.mocked(writeAuditLog);

function makeCtx(overrides: Partial<AdminAuditCtx>): AdminAuditCtx {
  return {
    path: "/admin/set-role",
    body: {},
    request: undefined,
    context: { returned: {}, session: { user: { id: "admin-1" } } },
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("handleAdminAuditEvent", () => {
  it("audits a state-changing set-role operation", async () => {
    await handleAdminAuditEvent(
      makeCtx({
        path: "/admin/set-role",
        body: { userId: "u-2", role: "admin" },
        context: { returned: {}, session: { user: { id: "admin-1" } } },
      }),
    );
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "admin-1",
        targetId: "u-2",
        targetType: "user",
        action: "user.role.change",
        details: { role: "admin" },
      }),
    );
  });

  it("does not audit a read path outside the route table", async () => {
    await handleAdminAuditEvent(makeCtx({ path: "/admin/list-users" }));
    expect(write).not.toHaveBeenCalled();
  });

  it("does not audit a failed operation", async () => {
    await handleAdminAuditEvent(
      makeCtx({ path: "/admin/ban-user", context: { returned: new Error("boom"), session: null } }),
    );
    expect(write).not.toHaveBeenCalled();
  });

  it("records ban reason and expiry details", async () => {
    await handleAdminAuditEvent(
      makeCtx({
        path: "/admin/ban-user",
        body: { userId: "u-2", banReason: "spam", banExpiresIn: 3600 },
      }),
    );
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "user.ban",
        details: { reason: "spam", expiresIn: 3600 },
      }),
    );
  });

  it("records create-user email and role details", async () => {
    await handleAdminAuditEvent(
      makeCtx({
        path: "/admin/create-user",
        body: { email: "new@test.example", role: "user" },
      }),
    );
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "user.create",
        details: { email: "new@test.example", role: "user" },
      }),
    );
  });

  it("nulls actor/target/details when absent", async () => {
    await handleAdminAuditEvent(
      makeCtx({
        path: "/admin/revoke-user-sessions",
        body: {},
        context: { returned: {}, session: null },
      }),
    );
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: null,
        targetId: null,
        details: null,
      }),
    );
  });

  it("does not reintroduce the deleted user's identifier into the audit log", async () => {
    await handleAdminAuditEvent(
      makeCtx({ path: "/admin/remove-user", body: { userId: "deleted-user" } }),
    );
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({ action: "user.delete", targetId: null }),
    );
  });
});
