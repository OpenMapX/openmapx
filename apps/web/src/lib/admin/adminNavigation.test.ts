import { expect, it } from "vitest";
import {
  adminDestinations,
  adminPrimaryNavigation,
  adminWorkspaceForPath,
  legacyAdminHref,
  safeAdminNavigationReturn,
} from "./adminNavigation";

it.each([true, null])("keeps nine primary workspaces for deployment %s", (selfHosted) => {
  const nav = adminPrimaryNavigation({ role: "admin", selfHosted });
  expect(nav.map((entry) => entry.id)).toEqual([
    "overview",
    "integrations",
    "extensions",
    "data",
    "users",
    "privacy",
    "activity",
    "settings",
    "system",
  ]);
  expect(nav.at(-1)?.href).toBe("/admin/system/services");
  expect(
    adminDestinations({ role: "admin", selfHosted }).some((entry) => entry.id === "diagnostics"),
  ).toBe(true);
});
it("keeps hosted System tools and restricts privacy administrators to casework", () => {
  expect(adminPrimaryNavigation({ role: "admin", selfHosted: false }).at(-1)?.href).toBe(
    "/admin/system/cache",
  );
  expect(
    adminDestinations({ role: "admin", selfHosted: false })
      .filter((entry) => entry.workspace === "system")
      .map((entry) => entry.id),
  ).toEqual(["cache", "configuration-transfer"]);
  expect(
    adminPrimaryNavigation({ role: "privacy_admin", selfHosted: null }).map((entry) => entry.href),
  ).toEqual(["/admin/privacy"]);
  expect(adminDestinations({ role: "user", selfHosted: true })).toEqual([]);
});
it("registers only existing B-stage Data topics and assigns one active workspace", () => {
  expect(
    adminDestinations({ role: "admin", selfHosted: true })
      .filter((entry) => entry.workspace === "data")
      .map((entry) => entry.href),
  ).toEqual(["/admin/data", "/admin/data/transit", "/admin/data/coverage"]);
  for (const path of [
    "/admin/services/api",
    "/admin/system/services/api",
    "/admin/services/compose",
  ])
    expect(adminWorkspaceForPath(path)).toBe("system");
  expect(adminWorkspaceForPath("/admin/services/data")).toBe("data");
  expect(adminWorkspaceForPath("/admin/privacy-setup")).toBe("privacy");
});
it.each([
  ["/admin/services", "/admin/system/services"],
  ["/admin/services/compose", "/admin/system/deployment"],
  ["/admin/services/data", "/admin/data"],
  ["/admin/services/backups", "/admin/system/backups"],
  ["/admin/services/api", "/admin/system/services/api"],
  ["/admin/transit", "/admin/data/transit"],
  ["/admin/coverage", "/admin/data/coverage"],
  ["/admin/cache", "/admin/system/cache"],
])("redirects %s retaining only public query state", (path, target) => {
  expect(legacyAdminHref(path, { tab: "configuration", page: "2", token: "secret" })).toBe(
    `${target}?tab=configuration&page=2`,
  );
});
it("distinguishes the System primary from the Maintenance root alias", () => {
  expect(legacyAdminHref("/admin/system", {}, true)).toBe("/admin/system/updates");
  expect(legacyAdminHref("/admin/system", {}, false)).toBe("/admin/system/cache");
});
it.each([
  "/admin/system/deployment",
  "/admin/system/configuration-transfer",
  "/admin/data/transit?tab=credentials",
  "/admin/transit",
  "/admin/users/a?tab=accounts",
  "/admin/system/services/api?tab=configuration",
])("accepts a canonical or legacy reauth destination %s", (path) => {
  expect(safeAdminNavigationReturn(path)).toBe(path);
});
it.each([
  "/admin/data/transit?tab=credentials&token=private",
  "/admin/settings/general?tab=logs",
  "/admin/system/services/%2fetc",
  "/admin/users/../settings",
  "//evil.test/admin",
  "/admin/unknown",
  "/admin/users/a?tab=profile&tab=sessions",
  "/admin/users/a#password",
])("rejects unsupported return state %s", (path) =>
  expect(safeAdminNavigationReturn(path)).toBeNull(),
);
