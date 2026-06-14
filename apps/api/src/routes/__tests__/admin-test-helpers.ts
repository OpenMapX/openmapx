/**
 * Shared harness for admin route tests.
 *
 * Usage pattern for each test file:
 *
 *   import { mockAdminSession } from "./admin-test-helpers.js";
 *
 *   // Mock the auth guard — all three exports must be provided because
 *   // require-admin.ts re-exports them from the same module.
 *   const fakeSession = mockAdminSession();
 *   vi.mock("../../utils/require-admin.js", () => ({
 *     requireAdmin: vi.fn().mockResolvedValue(fakeSession),
 *     getAdminSession: vi.fn().mockReturnValue(fakeSession),
 *     tryAdminSession: vi.fn().mockResolvedValue(fakeSession),
 *   }));
 *
 *   // Mock the database (match the import specifier from the route exactly)
 *   vi.mock("../../db/index.js", () => ({ db: { select: vi.fn(), insert: vi.fn(), ... } }));
 *
 *   // Mock docker utilities
 *   vi.mock("../../utils/docker-compose.js", () => ({
 *     dockerComposePs: vi.fn().mockResolvedValue([]),
 *     dockerComposeLogs: vi.fn(),
 *   }));
 *
 *   // Mock the audit log so writes become no-ops
 *   vi.mock("../../utils/audit-log.js", () => ({
 *     writeAuditLog: vi.fn().mockResolvedValue(undefined),
 *   }));
 *
 * Boot the route under test in `beforeAll` using the standard Fastify harness:
 *
 *   let app: FastifyInstance;
 *   beforeAll(async () => {
 *     const { adminServicesRoute } = await import("../admin-services.js");
 *     app = Fastify({ logger: false });
 *     await app.register(adminServicesRoute);
 *     await app.ready();
 *   });
 *   afterAll(() => app.close());
 *   afterEach(() => vi.clearAllMocks());
 *
 * Auth-rejection tests must create a second isolated app that registers the
 * route while requireAdmin is mocked to throw. Since vi.mock hoisting means the
 * module-level mock is already in place, use mockRejectedValueOnce inside the
 * test rather than a new vi.mock call.
 */

// Canonical session/auth fixtures live in the shared toolkit at src/test/.
export { mockAdminSession } from "../../test/auth.js";
