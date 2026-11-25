import { httpError } from "@openmapx/integration-framework";
import type { FastifyRequest } from "fastify";
import type * as RequireAdmin from "../utils/require-admin.js";
import { mockAdminSession } from "./auth.js";

/** The cookie a test sends to act as the administrator of `testAdminSessionModule`. */
export const TEST_ADMIN_COOKIE = "better-auth.session_token=test-admin-session";

function carriesTestCookie(request: FastifyRequest): boolean {
  const cookie = request.headers.cookie;
  return typeof cookie === "string" && cookie.split(/;\s*/).includes(TEST_ADMIN_COOKIE);
}

/**
 * A `vi.mock` factory result for `utils/require-admin` in tests that drive the
 * real admin routes without Better Auth's session tables. A request carrying
 * `TEST_ADMIN_COOKIE` resolves to `session`, the way the host CLI acts as an
 * administrator's session; any other request is refused with 401. Where the
 * database enforces foreign keys to `user`, the test inserts a row for the
 * session's user id.
 */
export function testAdminSessionModule(
  actual: typeof RequireAdmin,
  session = mockAdminSession(),
): typeof RequireAdmin {
  return {
    ...actual,
    async requireAdmin(request) {
      if (!carriesTestCookie(request)) throw httpError(401, "Authentication required");
      return session;
    },
    async tryAdminSession(request) {
      return carriesTestCookie(request) ? session : null;
    },
  };
}
