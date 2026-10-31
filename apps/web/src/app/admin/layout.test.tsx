// @vitest-environment node
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import AdminRootLayout from "./layout";

const request = new AsyncLocalStorage<string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({ toString: () => request.getStore() ?? "" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));
vi.mock("@/components/admin/AdminLayout", () => ({ AdminLayout: () => null }));
vi.mock("@openmapx/core/server-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core/server-api")>()),
  serverApiUrl: () => "http://server.test",
}));
afterEach(() => {
  vi.unstubAllGlobals();
});
describe("admin layout deployment boundary", () => {
  it("retains unknown deployment for an authenticated full admin during an outage", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      new URL(url).pathname === "/api/me"
        ? Response.json({ user: { name: "Admin", email: "admin@example.test", role: "admin" } })
        : Response.json({ error: "unavailable" }, { status: 503 }),
    );
    const rendered = await request.run("session=admin", () =>
      AdminRootLayout({ children: "child" }),
    );
    expect(rendered.props.selfHosted).toBeNull();
  });
  it("keeps me authentication and privacy_admin deployment skip", async () => {
    const paths: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      paths.push(new URL(url).pathname);
      expect(new Headers(init.headers).get("cookie")).toBe("session=privacy");
      expect(init.cache).toBe("no-store");
      return Response.json({
        user: { name: "Synthetic", email: "privacy@example.test", role: "privacy_admin" },
      });
    });
    const rendered = await request.run("session=privacy", () =>
      AdminRootLayout({ children: "child" }),
    );
    expect(rendered.props.selfHosted).toBe(false);
    expect(paths).toEqual(["/api/me"]);
  });
  it.each(["user", "anonymous"])("retains redirect for %s before deployment", async (role) => {
    const paths: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      paths.push(new URL(url).pathname);
      return role === "user"
        ? Response.json({ user: { role } })
        : Response.json({ error: "denied" }, { status: 401 });
    });
    await expect(
      request.run("session=other", () => AdminRootLayout({ children: "child" })),
    ).rejects.toThrow("redirect:/");
    expect(paths).toEqual(["/api/me"]);
  });
});
