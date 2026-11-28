import { expect, it } from "vitest";
import { adminJobHref, parseAdminJobSelection } from "./adminJobNavigation";

it("source-qualifies and encodes an exact job and safe return", () => {
  expect(
    adminJobHref({ id: "job /1", source: "data-manager", returnTo: "/admin/data/transit" }),
  ).toBe(
    "/admin/activity?tab=jobs&job=job+%2F1&source=data-manager&returnTo=%2Fadmin%2Fdata%2Ftransit",
  );
});
it.each([
  "https://evil.test/admin",
  "//evil.test/admin",
  "/admin-else",
  "/admin/users/../settings?token=secret",
  "/admin/unknown",
])("omits an untrusted return destination %s", (returnTo) => {
  expect(adminJobHref({ id: "job", source: "application", returnTo })).toBe(
    "/admin/activity?tab=jobs&job=job&source=application",
  );
});
it.each([
  "job=x",
  "job=x&source=external",
  "job=%0A&source=application",
  `job=${"x".repeat(257)}&source=application`,
])("rejects ambiguous or unsafe job selections", (query) => {
  expect(parseAdminJobSelection(new URLSearchParams(query))).toBeNull();
});
it("keeps both source and id, never treating source as a list filter", () => {
  expect(parseAdminJobSelection(new URLSearchParams("job=job-1&source=data-manager"))).toEqual({
    id: "job-1",
    source: "data-manager",
    returnTo: null,
  });
});

it("builds and parses a link to an integration task run", () => {
  const RUN_ID = "0193e4a0-0000-7000-8001-000000000002";
  const href = adminJobHref({ id: RUN_ID, source: "integration-task" });
  expect(href).toBe(`/admin/activity?tab=jobs&job=${RUN_ID}&source=integration-task`);
  expect(parseAdminJobSelection(new URL(href, "http://x").searchParams)).toMatchObject({
    id: RUN_ID,
    source: "integration-task",
  });
});

it.each(["", " ", "\n", "x".repeat(257)])(
  "falls back to Activity for an unaddressable server job %s",
  (id) => {
    expect(adminJobHref({ id, source: "application" })).toBe("/admin/activity?tab=jobs");
  },
);
