import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import { vi } from "vitest";
import { mockAdminSession } from "../../test/auth.js";

export function installAdminRouteMocks() {
  const session = mockAdminSession();
  const requireAdmin = vi.fn().mockResolvedValue(session);
  const getAdminSession = vi.fn().mockReturnValue(session);
  const tryAdminSession = vi.fn().mockResolvedValue(session);
  const writeAuditLog = vi.fn().mockResolvedValue(undefined);

  vi.doMock("../../utils/require-admin.js", () => ({
    requireAdmin: (...args: unknown[]) => requireAdmin(...args),
    getAdminSession: (...args: unknown[]) => getAdminSession(...args),
    tryAdminSession: (...args: unknown[]) => tryAdminSession(...args),
  }));
  vi.doMock("../../utils/audit-log.js", () => ({
    writeAuditLog: (...args: unknown[]) => writeAuditLog(...args),
  }));

  return { session, requireAdmin, getAdminSession, tryAdminSession, writeAuditLog };
}

export async function createAdminTestApp(route: FastifyPluginAsync): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(route);
  await app.ready();
  return app;
}
