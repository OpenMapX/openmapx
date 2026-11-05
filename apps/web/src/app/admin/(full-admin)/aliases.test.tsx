import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ redirect: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
it.each([
  [() => import("./services/page"), "/admin/system/services"],
  [() => import("./services/compose/page"), "/admin/system/deployment"],
  [() => import("./services/backups/page"), "/admin/system/backups"],
  [() => import("./services/data/page"), "/admin/data"],
  [() => import("./transit/page"), "/admin/data/transit"],
  [() => import("./coverage/page"), "/admin/data/coverage"],
  [() => import("./cache/page"), "/admin/system/cache"],
] as const)(
  "preserves supported navigation state through the legacy route",
  async (load, target) => {
    const { default: Page } = await load();
    await Page({
      searchParams: Promise.resolve({ tab: "credentials", page: "2", token: "private" }),
    });
    expect(mocks.redirect).toHaveBeenLastCalledWith(`${target}?tab=credentials&page=2`);
  },
);
it("encodes service IDs while redirecting details", async () => {
  const { default: Page } = await import("./services/[id]/page");
  await Page({
    params: Promise.resolve({ id: "service id" }),
    searchParams: Promise.resolve({ tab: "logs" }),
  });
  expect(mocks.redirect).toHaveBeenLastCalledWith("/admin/system/services/service%20id?tab=logs");
});
