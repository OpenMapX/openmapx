import de from "@openmapx/i18n/locales/de.json";
import { createTranslator } from "next-intl";
import { expect, it } from "vitest";
import { catalogTranslator } from "@/test/catalogTranslator";
import {
  adminSearchCopy,
  adminSettingHref,
  buildAdminSearchEntries,
  searchAdminEntries,
} from "./adminSearch";
import type { AdminTranslator } from "./adminTranslator";

const access = { role: "admin", selfHosted: true };
const copy = adminSearchCopy(
  catalogTranslator("adminNavigation"),
  catalogTranslator("adminShared"),
);
it("addresses the owning legal section without creating a duplicate policy editor", () => {
  expect(
    adminSettingHref({ group: "legal", subgroup: "retention", key: "retention.serverLogDays" }),
  ).toBe("/admin/privacy-setup?field=retention.serverLogDays#retention");
  expect(
    adminSettingHref({ group: "legal", subgroup: "operator", key: "legal.controller.name" }),
  ).toBe("/admin/privacy-setup?field=legal.controller.name#operator");
});
it.each([
  ["SMTP", "/admin/settings/email?field=smtp.host"],
  ["GTFS", "/admin/data/transit?tab=sources"],
  ["backup expiry", "/admin/system/backups#backup-retention"],
  ["release channel", "/admin/system/updates#release-selector"],
])("finds the current owning control for %s", (query, href) => {
  expect(searchAdminEntries(buildAdminSearchEntries(access, copy), query)[0]?.href).toBe(href);
});
it("titles, describes and keys entries in the reader's language", () => {
  const german = <Namespace extends string>(namespace: Namespace) =>
    createTranslator({
      locale: "de",
      messages: de,
      namespace: namespace as never,
    }) as unknown as AdminTranslator<Namespace>;
  const entries = buildAdminSearchEntries(
    access,
    adminSearchCopy(german("adminNavigation"), german("adminShared")),
  );
  expect(entries.find((entry) => entry.id === "overview")).toMatchObject({
    title: "Übersicht",
    description: "Handlungsbedarf, Zustand und laufende Aufgaben",
  });
  expect(searchAdminEntries(entries, "Fahrplandaten")[0]?.href).toBe(
    "/admin/data/transit?tab=sources",
  );
  expect(searchAdminEntries(entries, "Aufbewahrung")[0]?.href).toBe(
    "/admin/system/backups#backup-retention",
  );
});
it("indexes only public metadata, never effective or secret values", () => {
  const entries = buildAdminSearchEntries(access, copy, {
    settings: [
      {
        key: "smtp.host",
        group: "email",
        label: "SMTP host",
        value: "private-host",
        secret: false,
      } as never,
      {
        key: "smtp.password",
        group: "email",
        label: "SMTP password",
        value: "private-password",
        secret: true,
      } as never,
    ],
  });
  expect(searchAdminEntries(entries, "private")).toEqual([]);
  expect(searchAdminEntries(entries, "SMTP host")[0]?.href).toBe(
    "/admin/settings/email?field=smtp.host",
  );
  expect(JSON.stringify(entries)).not.toMatch(/private-host|private-password|value|secret/);
});
it("offers nothing to a non-administrator and bounds query and results", () => {
  expect(buildAdminSearchEntries({ role: "user", selfHosted: true }, copy)).toEqual([]);
  expect(searchAdminEntries(buildAdminSearchEntries(access, copy), "").length).toBeLessThanOrEqual(
    30,
  );
  expect(searchAdminEntries(buildAdminSearchEntries(access, copy), "x".repeat(201))).toEqual([]);
});

it("does not offer an ops-agent catalog action on hosted instances", () => {
  expect(
    buildAdminSearchEntries({ role: "admin", selfHosted: false }, copy, {
      operations: [{ id: "download-osm", title: "Download OSM", description: "Download" }],
    }).some((entry) => entry.id === "operation:download-osm"),
  ).toBe(false);
});
