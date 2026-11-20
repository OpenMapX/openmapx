import {
  activityAdminOperations,
  dataManagerAdminOperations,
  extensionAdminOperations,
  integrationAdminOperations,
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
      const operation = operations.find((entry) => entry.method === "GET" && entry.path === path);
      expect(operation?.responses[200]?.schema).toBeDefined();
      expect(() => operation?.responses[200]?.schema?.parse(body)).not.toThrow();
    },
  );

  it("signs in an administrator with the same identity everywhere", () => {
    const session = fixtures["/api/auth/get-session"];
    expect(fixtures["/api/me"].user).toMatchObject({ id: session.user.id, role: "admin" });
    expect(session.user.role).toBe("admin");
    expect(fixtures["/api/auth/admin/list-users"].users.map((user) => user.id)).toContain(
      session.user.id,
    );
  });
});
