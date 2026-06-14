import type { FastifyRequest } from "fastify";
import { vi } from "vitest";
import type { AdminSession } from "../utils/require-admin.js";

/**
 * A minimal `AdminSession` fixture satisfying every field admin routes read
 * (user.id for audit actor, user.email, user.role). Canonical home — the older
 * `routes/__tests__/admin-test-helpers.ts` re-exports this.
 */
export function mockAdminSession(): AdminSession {
  return {
    user: {
      id: "test-admin-id",
      role: "admin",
      name: "Test Admin",
      email: "admin@test.example",
      emailVerified: true,
      createdAt: new Date("2024-01-01"),
      updatedAt: new Date("2024-01-01"),
    },
    session: {
      id: "test-session-id",
      userId: "test-admin-id",
      token: "test-token",
      createdAt: new Date("2024-01-01"),
      updatedAt: new Date("2024-01-01"),
      expiresAt: new Date("2099-01-01"),
      ipAddress: "127.0.0.1",
      userAgent: "test",
    },
  } as unknown as AdminSession;
}

/**
 * Module-mock implementation for `../utils/require-auth.js`. Pass to `vi.mock`
 * so user-scoped routes see `getUserId(request) === userId` and the preHandler
 * stashes it:
 *
 *   vi.mock("../../utils/require-auth.js", () => mockRequireAuth("user-1"));
 *
 * Returns `vi.fn()`s so a test can flip `getUserId`/`requireAuth` to throw a
 * 401 for the unauthenticated path.
 */
export function mockRequireAuth(userId = "test-user-id") {
  return {
    requireAuth: vi.fn(async () => userId),
    requireAuthHook: vi.fn(async (request: FastifyRequest) => {
      (request as FastifyRequest & { userId?: string }).userId = userId;
    }),
    getUserId: vi.fn(() => userId),
  };
}
