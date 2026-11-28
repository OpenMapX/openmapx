import {
  accountAdminOperations,
  activityAdminOperations,
  dataManagerAdminOperations,
  extensionAdminOperations,
  integrationAdminOperations,
  privacyAdminOperations,
  serviceAdminOperations,
} from "@openmapx/core/api-contracts";
import { describe, expect, it } from "vitest";
import fixtures from "../../e2e/admin-fixtures.json";

type Operation = {
  method: string;
  path: string;
  responses: Partial<Record<number, { schema?: { parse(value: unknown): unknown } }>>;
};
const operations = Object.values({
  ...accountAdminOperations,
  ...privacyAdminOperations,
  ...activityAdminOperations,
  ...dataManagerAdminOperations,
  ...extensionAdminOperations,
  ...integrationAdminOperations,
  ...serviceAdminOperations,
}) as unknown as readonly Operation[];

/** Answers that come from the auth service rather than an admin operation contract. */
const AUTH_ROUTES = new Set(["/api/me", "/api/auth/get-session", "/api/auth/admin/list-users"]);

describe("admin journey fixtures", () => {
  it.each(Object.entries(fixtures).filter(([path]) => !AUTH_ROUTES.has(path)))(
    "answers %s with a body its admin contract accepts",
    (path, body) => {
      const gets = operations.filter((entry) => entry.method === "GET");
      // A fixture for one record answers its templated path, such as `/requests/:id`.
      const operation =
        gets.find((entry) => entry.path === path) ??
        gets.find((entry) =>
          new RegExp(`^${entry.path.replace(/:[A-Za-z]+/g, "[^/]+")}$`).test(path),
        );
      expect(operation?.responses[200]?.schema).toBeDefined();
      expect(() => operation?.responses[200]?.schema?.parse(body)).not.toThrow();
    },
  );

  it("answers the safe-mode state the integration list asks for, with safe mode off", () => {
    expect((fixtures as Record<string, unknown>)["/api/admin/safe-mode"]).toEqual({
      active: false,
      reason: null,
      integrationId: null,
    });
  });

  it("signs in an administrator with the same identity everywhere", () => {
    const session = fixtures["/api/auth/get-session"];
    expect(fixtures["/api/me"].user).toMatchObject({ id: session.user.id, role: "admin" });
    expect(session.user.role).toBe("admin");
    expect(fixtures["/api/auth/admin/list-users"].users.map((user) => user.id)).toContain(
      session.user.id,
    );
  });
});
