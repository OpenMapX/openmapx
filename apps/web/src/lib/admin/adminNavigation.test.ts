import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import {
  ADMIN_DESTINATIONS,
  adminDestinations,
  adminPrimaryNavigation,
  adminWorkspaceForPath,
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
    adminDestinations({ role: "admin", selfHosted: false })
      .filter((entry) => entry.workspace === "data")
      .map((entry) => entry.id),
  ).toEqual(["data", "transit", "coverage"]);
  expect(adminDestinations({ role: "user", selfHosted: true })).toEqual([]);
});
it("registers the final Data topics and assigns one active workspace", () => {
  expect(
    adminDestinations({ role: "admin", selfHosted: true })
      .filter((entry) => entry.workspace === "data")
      .map((entry) => entry.href),
  ).toEqual([
    "/admin/data",
    "/admin/data/osm",
    "/admin/data/overture",
    "/admin/data/search",
    "/admin/data/transit",
    "/admin/data/coverage",
    "/admin/data/transfers",
    "/admin/data/operations",
  ]);
  for (const path of ["/admin/system/services/api", "/admin/system/deployment"])
    expect(adminWorkspaceForPath(path)).toBe("system");
  expect(adminWorkspaceForPath("/admin/data/transit")).toBe("data");
  expect(adminWorkspaceForPath("/admin/privacy-setup")).toBe("privacy");
});
it.each([
  "/admin/system/deployment",
  "/admin/system/configuration-transfer",
  "/admin/data/transit?tab=credentials",
  "/admin/users/a?tab=accounts",
  "/admin/system/services/api?tab=configuration",
])("accepts the canonical reauth destination %s", (path) => {
  expect(safeAdminNavigationReturn(path)).toBe(path);
});
it.each([
  "/admin/data/transit?tab=credentials&token=private",
  "/admin/settings/email?tab=logs",
  "/admin/system/services/%2fetc",
  "/admin/users/../settings",
  "//evil.test/admin",
  "/admin/unknown",
  "/admin/services",
  "/admin/services/api",
  "/admin/transit",
  "/admin/coverage",
  "/admin/cache",
  "/admin/settings",
  "/admin/system",
  "/admin/users/a?tab=profile&tab=sessions",
  "/admin/users/a#password",
])("rejects unsupported return state %s", (path) =>
  expect(safeAdminNavigationReturn(path)).toBeNull(),
);

// Route groups such as `(full-admin)` add no URL segment; `[id]` matches any one segment.
const adminRoutes = readdirSync(resolve(import.meta.dirname, "../../app/admin"), {
  recursive: true,
  encoding: "utf8",
})
  .filter((file) => /(^|\/)page\.tsx$/.test(file))
  .map((file) =>
    ["admin", ...file.split("/").slice(0, -1)].filter((segment) => !/^\(.*\)$/.test(segment)),
  );
const hasPage = (href: string) => {
  const segments = href.split("/").filter(Boolean);
  return adminRoutes.some(
    (route) =>
      route.length === segments.length &&
      route.every((segment, index) => /^\[.*\]$/.test(segment) || segment === segments[index]),
  );
};
it.each(ADMIN_DESTINATIONS.map((entry) => entry.href))(
  "serves a page for the admin destination %s",
  (href) => {
    expect(hasPage(href)).toBe(true);
  },
);
it("does not treat a path without a page file as served", () => {
  expect(hasPage("/admin/data/missing")).toBe(false);
});
