import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin, customSession } from "better-auth/plugins";
import { describe, expect, it } from "vitest";
import { projectSessionPayload, projectSessionRow } from "../session-projection";

const storedRow = {
  id: "s1",
  userId: "u1",
  token: "fixture-not-a-real-token",
  expiresAt: new Date("2030-01-01T00:00:00.000Z"),
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ipAddress: "203.0.113.7",
  userAgent: "fixture-agent/1.0",
  impersonatedBy: null,
};

describe("projectSessionRow", () => {
  it("drops the session token, the stored IP address and the user agent", () => {
    const projected = projectSessionRow(storedRow);
    expect(projected).not.toHaveProperty("token");
    expect(projected).not.toHaveProperty("ipAddress");
    expect(projected).not.toHaveProperty("userAgent");
    expect(JSON.stringify(projected)).not.toContain("fixture-not-a-real-token");
    expect(JSON.stringify(projected)).not.toContain("203.0.113.7");
  });

  it("keeps the fields callers read", () => {
    expect(projectSessionRow(storedRow)).toEqual({
      id: "s1",
      userId: "u1",
      expiresAt: storedRow.expiresAt,
      createdAt: storedRow.createdAt,
      updatedAt: storedRow.updatedAt,
      impersonatedBy: null,
    });
  });

  it("keeps the impersonation marker the admin banner reads", () => {
    expect(projectSessionRow({ ...storedRow, impersonatedBy: "admin-1" }).impersonatedBy).toBe(
      "admin-1",
    );
  });

  it("does not let an unknown upstream column through", () => {
    const withExtra = { ...storedRow, futureSecret: "leak-me" };
    expect(JSON.stringify(projectSessionRow(withExtra))).not.toContain("leak-me");
  });
});

describe("projectSessionPayload", () => {
  it("passes the user object through untouched", () => {
    const user = { id: "u1", name: "Ada", email: "ada@example.com", role: "admin" };
    const result = projectSessionPayload({ user, session: storedRow });
    expect(result.user).toBe(user);
    expect(result.session).not.toHaveProperty("token");
  });
});

function buildTestAuth() {
  const options = {
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    baseURL: "http://localhost:3000",
    secret: "session-projection-test-secret-not-a-real-credential",
    emailAndPassword: { enabled: true, autoSignIn: true },
    plugins: [admin()],
  };
  return betterAuth({
    ...options,
    plugins: [
      ...options.plugins,
      customSession(async ({ user, session }) => projectSessionPayload({ user, session }), options),
    ],
  });
}

describe("the session endpoint", () => {
  it("does not return the session token, IP address or user agent", async () => {
    const testAuth = buildTestAuth();

    const signUp = await testAuth.api.signUpEmail({
      body: { name: "Ada", email: "ada@example.com", password: "fixture-password-1234" },
      asResponse: true,
    });
    const cookie = signUp.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
    expect(cookie).not.toBe("");

    const result = await testAuth.api.getSession({ headers: new Headers({ cookie }) });

    expect(result).not.toBeNull();
    expect(result?.user.email).toBe("ada@example.com");
    expect(result?.session).not.toHaveProperty("token");
    expect(result?.session).not.toHaveProperty("ipAddress");
    expect(result?.session).not.toHaveProperty("userAgent");
    expect(JSON.stringify(result)).not.toContain(signUp.headers.get("set-cookie") ?? "");
  });

  it("still sets no-store on the session response", async () => {
    const testAuth = buildTestAuth();
    const signUp = await testAuth.api.signUpEmail({
      body: { name: "Ada", email: "ada2@example.com", password: "fixture-password-1234" },
      asResponse: true,
    });
    const cookie = signUp.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");

    const response = await testAuth.api.getSession({
      headers: new Headers({ cookie }),
      asResponse: true,
    });

    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});
