import { expect, it } from "vitest";
import { adminQueryHref, parseAdminCaseSelection } from "./adminNavigationState";

it("encodes selection, drops arbitrary query values and preserves supported filters", () => {
  expect(
    adminQueryHref("/admin/activity", new URLSearchParams("status=failed&page=2&password=never"), {
      job: "a /b",
      source: "data-manager",
      tab: "jobs",
    }),
  ).toBe("/admin/activity?status=failed&page=2&job=a+%2Fb&source=data-manager&tab=jobs");
});
it("clears only the named selection keys", () => {
  expect(
    adminQueryHref(
      "/admin/activity",
      new URLSearchParams("tab=jobs&job=a&source=application&status=failed"),
      { job: null, source: null },
    ),
  ).toBe("/admin/activity?tab=jobs&status=failed");
});
it.each(["", " ", "\n", "x".repeat(257)])(
  "rejects an empty or unsafe privacy case identifier",
  (id) => {
    expect(parseAdminCaseSelection(new URLSearchParams({ case: id, section: "unknown" }))).toEqual({
      caseId: null,
      section: "identity",
    });
  },
);
it("keeps a valid case and section for direct navigation", () => {
  expect(parseAdminCaseSelection(new URLSearchParams("case=case-123&section=attachments"))).toEqual(
    { caseId: "case-123", section: "attachments" },
  );
});
