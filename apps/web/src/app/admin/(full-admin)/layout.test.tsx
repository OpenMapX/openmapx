// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ role: "admin" }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ toString: () => "session=test" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));
vi.mock("@openmapx/core/server-api", () => ({ serverApiUrl: () => "http://api.test" }));

vi.stubGlobal(
  "fetch",
  vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify({ user: { role: session.role } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  ),
);

import FullAdminLayout from "./layout";

describe("full administrator routes", () => {
  afterEach(() => {
    session.role = "admin";
  });

  it("allows a full administrator to render privacy setup", async () => {
    const children = "privacy setup";
    expect(await FullAdminLayout({ children })).toBe(children);
  });

  it("sends any other account away from the administration surface", async () => {
    session.role = "user";
    await expect(FullAdminLayout({ children: "privacy setup" })).rejects.toThrow("redirect:/");
  });
});
