import { expect, it } from "vitest";
import { adminSettingHref, buildAdminSearchEntries, searchAdminEntries } from "./adminSearch";

const access = { role: "admin", selfHosted: true };
it("addresses the owning legal section without creating a duplicate policy editor", () => {
  expect(
    adminSettingHref({ group: "legal", subgroup: "retention", key: "legalRetentionDays" }),
  ).toBe("/admin/privacy-setup?field=legalRetentionDays#retention");
  expect(
    adminSettingHref({ group: "legal", subgroup: "operator", key: "legalControllerName" }),
  ).toBe("/admin/privacy-setup?field=legalControllerName#operator");
});
it.each([
  ["SMTP", "/admin/settings/email?field=smtpHost"],
  ["GTFS", "/admin/data/transit?tab=sources"],
  ["backup expiry", "/admin/system/backups#backup-retention"],
  ["release channel", "/admin/system/updates#release-selector"],
])("finds the current owning control for %s", (query, href) => {
  expect(searchAdminEntries(buildAdminSearchEntries(access), query)[0]?.href).toBe(href);
});
it("indexes only public metadata, never effective or secret values", () => {
  const entries = buildAdminSearchEntries(access, {
    settings: [
      {
        key: "smtpHost",
        group: "email",
        label: "SMTP host",
        value: "private-host",
        secret: false,
      } as never,
      {
        key: "smtpPassword",
        group: "email",
        label: "SMTP password",
        value: "private-password",
        secret: true,
      } as never,
    ],
  });
  expect(searchAdminEntries(entries, "private")).toEqual([]);
  expect(searchAdminEntries(entries, "SMTP host")[0]?.href).toBe(
    "/admin/settings/email?field=smtpHost",
  );
  expect(JSON.stringify(entries)).not.toMatch(/private-host|private-password|value|secret/);
});
it("retains narrower access and bounds query and results", () => {
  const entries = buildAdminSearchEntries({ role: "privacy_admin", selfHosted: true });
  expect(entries.map((entry) => entry.href)).toEqual(["/admin/privacy"]);
  expect(searchAdminEntries(buildAdminSearchEntries(access), "").length).toBeLessThanOrEqual(30);
  expect(searchAdminEntries(buildAdminSearchEntries(access), "x".repeat(201))).toEqual([]);
});

it("does not offer an ops-agent catalog action on hosted instances", () => {
  expect(
    buildAdminSearchEntries(
      { role: "admin", selfHosted: false },
      { operations: [{ id: "download-osm", title: "Download OSM", description: "Download" }] },
    ).some((entry) => entry.id === "operation:download-osm"),
  ).toBe(false);
});
