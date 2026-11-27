import { Writable } from "node:stream";
import { inflateRawSync } from "node:zlib";
import type { LoadedIntegration, SubjectDataHandler } from "@openmapx/integration-framework";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentIntegrationScope } from "../../integration-scope";
import { archivePathForLogicalId } from "../archive-writer";
import { catalogueAvailability, SUBJECT_DATA_CATALOGUE, subjectDataCatalogue } from "../catalogue";
import { getCatalogueCopy } from "../catalogue-copy";
import type { CollectorSourcePart } from "../collectors";
import {
  registerSubjectDataHandlerFor,
  setSubjectDataIntegrationSource,
} from "../extension-handlers";
import {
  collectExtensionParts,
  EXPORT_DEADLINE_MS,
  MAX_EXTENSION_EXPORT_BYTES,
} from "../extension-subject-data";
import { buildPrivacyResponseReport } from "../response-report";
import { prepareSubjectExport } from "../subject-export";

const collectors = vi.hoisted(() => ({
  platformOutcome: "included" as CollectorSourcePart["outcome"],
}));

vi.mock("../report-settings.js", () => ({
  PrivacyLegalConfigurationError: class extends Error {},
  resolvePrivacyReportLegalFacts: async () => ({
    controller: {
      name: "Example Controller",
      address: "Street 1\n10115 Berlin\nGermany",
      email: "privacy@example.test",
      phone: null,
    },
    deployment: {
      jurisdiction: "DE-BE",
      supervisoryAuthority: "Berlin Authority",
      supervisoryAuthorityUrl: null,
      privacySources: [],
      dsarCaseRetentionDays: 1095,
      backupRetentionDays: 30,
      serverLogRetentionDays: 30,
      auditLogRetentionDays: 365,
      adminJobRetentionDays: 30,
    },
  }),
}));

vi.mock("../openmapx-collectors.js", () => ({
  collectOpenMapxDataSnapshot: async () => ({
    snapshotAt: new Date("2026-01-01T00:03:00.000Z"),
    parts: [
      {
        registrationId: "account-profile",
        category: "account",
        records: [{ id: "profile", portable: true, data: { name: "Person" } }],
        outcome: collectors.platformOutcome,
        warningCodes: [],
        capturedAt: "2026-01-01T00:03:00.000Z",
      },
    ],
    entries: [],
  }),
}));

vi.mock("../collectors/dawarich.js", () => ({
  collectManagedDawarich: async () => ({
    registrationId: "managed-dawarich",
    category: "timeline",
    records: [],
    outcome: "not_applicable",
    warningCodes: [],
    capturedAt: "2026-01-01T00:03:00.000Z",
  }),
}));

const NOTES_ENTRY = {
  id: "acme-overlay-notes",
  version: 1,
  category: "saved-content",
  strategy: "collector",
  locators: [{ type: "user_id", field: "ext_acme_overlay.note.user_id" }],
  purposes: ["saved-content"],
  legalBases: ["contract"],
  origin: { kind: "subject", descriptionCode: "subject-provided" },
  retention: { kind: "account-lifetime", daysAfterClosure: 30, reasonCode: "erasure-replay" },
  recipients: [{ id: "openmapx-controller", roleCode: "controller" }],
  article15: "include",
  portability: { decision: "include", format: "json" },
  secretPolicy: { mode: "metadata", code: "note-metadata" },
  rightsOfOthers: { mode: "none" },
  title: "Overlay notes",
  description: "Notes you pinned on the Acme overlay",
};

function integration(
  id: string,
  name: string,
  options: {
    loadState?: LoadedIntegration["loadState"];
    registrations?: unknown[];
    isBuiltIn?: boolean;
  } = {},
): LoadedIntegration {
  return {
    id,
    manifest: {
      id,
      name,
      ...(options.registrations
        ? {
            subjectData: {
              storesPersonalData: true,
              strategy: "collector",
              registrationIds: ["placeholder"],
              registrations: options.registrations,
              operatorInstructions: null,
            },
          }
        : {}),
    } as unknown as LoadedIntegration["manifest"],
    config: {},
    directory: `/integrations/${id}`,
    isBuiltIn: options.isBuiltIn ?? false,
    enabled: true,
    providers: new Map(),
    strings: {},
    loadState: options.loadState ?? "loaded",
    shutdownHandlers: [],
  };
}

function withHandler(target: LoadedIntegration, exportData: SubjectDataHandler["export"]) {
  registerSubjectDataHandlerFor(
    target,
    { integrationId: target.id, isBuiltIn: target.isBuiltIn, revoked: false },
    { export: exportData, erase: async () => {} },
  );
  return target;
}

function zipMembers(zip: Buffer): Map<string, Buffer> {
  const members = new Map<string, Buffer>();
  for (let offset = 0; offset < zip.length - 46; offset += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) continue;
    const method = zip.readUInt16LE(offset + 10);
    const size = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const compressed = zip.subarray(start, start + size);
    members.set(name, method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed));
  }
  return members;
}

/** A database whose only statement is the handler-table read. */
function databaseListing(listed: string[]) {
  const client = vi.fn(async () => listed.map((integration_id) => ({ integration_id })));
  return { $client: client } as unknown as NonNullable<
    Parameters<typeof prepareSubjectExport>[0]["database"]
  >;
}

async function exportArchive(listed: string[] = []) {
  const prepared = await prepareSubjectExport({
    request: {
      id: "00000000-0000-7000-8000-000000000001",
      kind: "access_and_portability",
      locale: "en",
      receivedAt: new Date("2026-01-01T00:00:00.000Z"),
      registeredAt: new Date("2026-01-01T00:01:00.000Z"),
      preservationAt: null,
      snapshotAt: new Date("2026-01-01T00:03:00.000Z"),
    },
    subjectUserId: "subject-1",
    database: databaseListing(listed),
    now: () => new Date("2026-01-02T00:00:00.000Z"),
    openmapx: {},
  });
  const chunks: Buffer[] = [];
  await prepared.write(
    new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
  );
  await prepared.dispose();
  const members = zipMembers(Buffer.concat(chunks));
  const read = (path: string) => members.get(`openmapx-data-export/${path}`)?.toString("utf8");
  return {
    members,
    read,
    manifest: JSON.parse(read("manifest.json") ?? "null"),
    processing: JSON.parse(read("article-15/processing-information.json") ?? "null"),
  };
}

const log = { warn: vi.fn() };

beforeEach(() => {
  collectors.platformOutcome = "included";
  log.warn.mockClear();
});

afterEach(() => {
  setSubjectDataIntegrationSource(null);
  vi.useRealTimers();
});

describe("extension export parts", () => {
  async function partsFor(
    registry: LoadedIntegration[] | null,
    listed: string[] = [],
  ): Promise<CollectorSourcePart[]> {
    return collectExtensionParts({
      userId: "subject-1",
      integrations: registry,
      listed: async () => listed,
      log,
    });
  }

  it("includes what a loaded extension returns, asked in its scope", async () => {
    let scope: string | undefined;
    const overlay = withHandler(integration("acme-overlay", "Acme overlay"), async (subjectId) => {
      scope = currentIntegrationScope()?.integrationId;
      return { subjectId, notes: [{ body: "x" }] };
    });

    const [part] = await partsFor([overlay]);

    expect(scope).toBe("acme-overlay");
    expect(part).toMatchObject({
      registrationId: "extension-acme-overlay",
      outcome: "included",
      warningCodes: [],
      blocking: false,
      extension: { integrationId: "acme-overlay", name: "Acme overlay" },
    });
    expect(JSON.parse(String(part?.entries?.[0]?.source))).toEqual({
      subjectId: "subject-1",
      notes: [{ body: "x" }],
    });
    expect(part?.entries?.[0]?.logicalId).toBe("extension-acme-overlay");
  });

  it("includes nothing it was not asked for", async () => {
    const parts = await partsFor(
      [
        integration("plain", "Plain"),
        integration("listed-loaded", "Listed but no handler"),
        integration("unlisted", "Not loaded, not listed", { loadState: "failed" }),
      ],
      ["listed-loaded", "uninstalled"],
    );
    expect(parts).toEqual([]);
  });

  it("lists an installed extension that is not loaded but handles subject data", async () => {
    const parts = await partsFor(
      [
        integration("acme-tracker", "Acme tracker", { loadState: "safe-mode" }),
        { ...integration("acme-off", "Acme off"), enabled: false },
      ],
      ["acme-tracker", "acme-off"],
    );
    expect(
      parts.map((part) => [part.extension?.integrationId, part.outcome, part.warningCodes]),
    ).toEqual([
      ["acme-tracker", "unavailable", ["extension-not-loaded"]],
      ["acme-off", "unavailable", ["extension-not-loaded"]],
    ]);
    expect(parts.every((part) => part.blocking === false && !part.entries)).toBe(true);
  });

  it("lists every listed extension as not loaded where no registry runs", async () => {
    const parts = await partsFor(null, ["acme-tracker"]);
    expect(parts).toMatchObject([
      {
        registrationId: "extension-acme-tracker",
        outcome: "unavailable",
        warningCodes: ["extension-not-loaded"],
        extension: { integrationId: "acme-tracker", name: "acme-tracker" },
      },
    ]);
  });

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  it.each([
    ["throws", () => Promise.reject(new Error("boom"))],
    ["rejects with an object without a prototype", () => Promise.reject(Object.create(null))],
    [
      "throws before returning a promise",
      (() => {
        throw new Error("at once");
      }) as SubjectDataHandler["export"],
    ],
    ["returns a cyclic structure", async () => cyclic],
    ["returns a BigInt", async () => ({ count: 10n })],
    ["returns a function", async () => () => "data"],
    [
      "returns a value whose toJSON throws",
      async () => ({
        toJSON() {
          throw new Error("no");
        },
      }),
    ],
  ])("records a failed part when the handler %s", async (_label, exportData) => {
    const broken = withHandler(integration("acme-broken", "Acme broken"), exportData);

    const [part] = await partsFor([broken]);

    expect(part).toMatchObject({
      outcome: "unavailable",
      warningCodes: ["extension-handler-failed"],
      blocking: false,
    });
    expect(part?.entries).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ integrationId: "acme-broken", error: expect.any(String) }),
      expect.stringContaining("acme-broken"),
    );
  });

  it("records a part larger than 8 MiB as too large", async () => {
    const large = withHandler(integration("acme-large", "Acme large"), async () => ({
      blob: "x".repeat(MAX_EXTENSION_EXPORT_BYTES),
    }));
    const exact = withHandler(integration("acme-exact", "Acme exact"), async () =>
      "x".repeat(MAX_EXTENSION_EXPORT_BYTES - 2),
    );

    const parts = await partsFor([large, exact]);

    expect(
      parts.map((part) => [part.extension?.integrationId, part.outcome, part.warningCodes]),
    ).toEqual([
      ["acme-large", "unavailable", ["extension-export-too-large"]],
      ["acme-exact", "included", []],
    ]);
  });

  it("stops waiting at the deadline and asks every extension at once", async () => {
    vi.useFakeTimers();
    const hung = [1, 2].map((n) =>
      withHandler(integration(`acme-hung-${n}`, `Acme hung ${n}`), () => new Promise(() => {})),
    );
    let settled = false;
    const collecting = partsFor(hung).then((parts) => {
      settled = true;
      return parts;
    });

    await vi.advanceTimersByTimeAsync(EXPORT_DEADLINE_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect((await collecting).map((part) => part.warningCodes)).toEqual([
      ["extension-handler-failed"],
      ["extension-handler-failed"],
    ]);
  });
});

describe("subject export with extensions", () => {
  it("includes what a loaded extension returns", async () => {
    const overlay = withHandler(integration("acme-overlay", "Acme overlay"), async () => ({
      notes: [{ body: "x" }],
    }));
    setSubjectDataIntegrationSource(() => [overlay]);

    const { read, manifest } = await exportArchive();

    expect(archivePathForLogicalId("extension-acme-overlay")).toBe(
      "openmapx-data-export/extensions/acme-overlay.json",
    );
    expect(JSON.parse(read("extensions/acme-overlay.json") ?? "null")).toEqual({
      notes: [{ body: "x" }],
    });
    expect(manifest.extensions).toContainEqual({
      integrationId: "acme-overlay",
      name: "Acme overlay",
      outcome: "included",
      warningCode: null,
    });
    expect(read("README.txt")).not.toContain("Extensions that could not be asked");
  });

  it("lists an extension it could not ask and still delivers the export", async () => {
    const tracker = integration("acme-tracker", "Acme tracker", { loadState: "safe-mode" });
    const broken = withHandler(integration("acme-broken", "Acme broken"), async () => {
      throw new Error("boom");
    });
    setSubjectDataIntegrationSource(() => [tracker, broken]);

    const { read, manifest, processing } = await exportArchive(["acme-tracker"]);

    expect(manifest.extensions).toContainEqual(
      expect.objectContaining({
        integrationId: "acme-tracker",
        outcome: "unavailable",
        warningCode: "extension-not-loaded",
      }),
    );
    expect(manifest.extensions).toContainEqual(
      expect.objectContaining({
        integrationId: "acme-broken",
        outcome: "unavailable",
        warningCode: "extension-handler-failed",
      }),
    );
    expect(processing.extensions).toEqual(manifest.extensions);
    const readme = read("README.txt") ?? "";
    expect(readme).toContain("Extensions that could not be asked");
    expect(readme).toContain("Acme tracker (acme-tracker)");
    expect(readme).toContain("Acme broken (acme-broken)");
    expect(read("extensions/acme-tracker.json")).toBeUndefined();
  });

  it("still refuses when a platform collector is unavailable", async () => {
    collectors.platformOutcome = "unavailable";
    await expect(exportArchive()).rejects.toMatchObject({
      code: "COLLECTOR_UNAVAILABLE",
      statusCode: 503,
    });
  });
});

describe("extension-declared catalogue entries", () => {
  it("shows extension-declared catalogue entries in the processing information", async () => {
    const overlay = withHandler(
      integration("acme-overlay", "Acme overlay", { registrations: [NOTES_ENTRY] }),
      async () => ({ notes: [] }),
    );
    setSubjectDataIntegrationSource(() => [overlay]);

    const catalogue = subjectDataCatalogue();
    expect(catalogue.slice(0, SUBJECT_DATA_CATALOGUE.length)).toEqual(SUBJECT_DATA_CATALOGUE);
    const declared = catalogue.find((entry) => entry.id === "acme-overlay-notes");
    expect(declared).toMatchObject({
      source: "extension",
      collectorId: "extension:acme-overlay",
      category: "saved-content",
    });
    expect(declared).not.toHaveProperty("title");
    expect(getCatalogueCopy("de", "acme-overlay-notes")).toMatchObject({
      category: "Overlay notes",
      purpose: "Notes you pinned on the Acme overlay",
    });

    const { processing, read } = await exportArchive();
    expect(processing.sources).toContainEqual(
      expect.objectContaining({
        id: "acme-overlay-notes",
        source: "extension",
        outcome: "included",
        explanation: expect.objectContaining({ category: "Overlay notes" }),
      }),
    );
    expect(read("README.txt")).toContain("acme-overlay-notes — Overlay notes");
  });

  it("leaves out a declared entry that does not validate and keeps the others", () => {
    const warn = vi.fn();
    const overlay = integration("acme-overlay", "Acme overlay", {
      registrations: [
        { ...NOTES_ENTRY, id: "acme-overlay-broken", purposes: ["not-a-purpose"] },
        NOTES_ENTRY,
        { ...NOTES_ENTRY, id: "account-profile" },
        { ...NOTES_ENTRY, id: "acme-overlay-sourced", source: "openmapx-db" },
        { ...NOTES_ENTRY, id: "acme-overlay-untitled", title: 7 },
      ],
    });
    setSubjectDataIntegrationSource(() => [overlay], { warn });

    const ids = () =>
      subjectDataCatalogue()
        .filter((entry) => entry.source === "extension")
        .map((entry) => entry.id);
    expect(ids()).toEqual(["acme-overlay-notes"]);
    expect(ids()).toEqual(["acme-overlay-notes"]);

    // One warning per entry left out, across both reads.
    expect(
      warn.mock.calls
        .map(([fields]) => fields as { integrationId: string; index: number })
        .map(({ integrationId, index }) => `${integrationId}#${index}`)
        .sort(),
    ).toEqual(["acme-overlay#0", "acme-overlay#2", "acme-overlay#3", "acme-overlay#4"]);
    for (const [, message] of warn.mock.calls) expect(message).toContain("acme-overlay");
  });

  it("validates the entries of the parsed manifest", () => {
    const raw = JSON.parse(
      `{"subjectData":{"storesPersonalData":true,"strategy":"collector","registrationIds":["acme-overlay-notes"],"operatorInstructions":null,"registrations":[${JSON.stringify(
        NOTES_ENTRY,
      ).replace(/^\{/, '{"__proto__":{"polluted":true},')}]}}`,
    );
    expect(Object.hasOwn(raw.subjectData.registrations[0], "__proto__")).toBe(true);
    const overlay = integration("acme-overlay", "Acme overlay");
    overlay.manifest = { ...overlay.manifest, subjectData: raw.subjectData };
    setSubjectDataIntegrationSource(() => [overlay]);

    const declared = subjectDataCatalogue().find((entry) => entry.id === "acme-overlay-notes");

    expect(declared).toBeDefined();
    expect(Object.hasOwn(declared ?? {}, "__proto__")).toBe(false);
    expect((declared as Record<string, unknown> | undefined)?.polluted).toBeUndefined();
  });

  it("takes no entries from a built-in manifest", () => {
    setSubjectDataIntegrationSource(() => [
      integration("weather", "Weather", { registrations: [NOTES_ENTRY], isBuiltIn: true }),
    ]);
    expect(subjectDataCatalogue()).toEqual(SUBJECT_DATA_CATALOGUE);
  });

  it("reports an extension's catalogue entry as available only while its handler is loaded", () => {
    const overlay = withHandler(
      integration("acme-overlay", "Acme overlay", { registrations: [NOTES_ENTRY] }),
      async () => null,
    );
    const tracker = integration("acme-tracker", "Acme tracker", {
      loadState: "safe-mode",
      registrations: [{ ...NOTES_ENTRY, id: "acme-tracker-trips" }],
    });
    setSubjectDataIntegrationSource(() => [overlay, tracker]);
    const entryOf = (integrationId: string) => {
      const entry = subjectDataCatalogue().find(
        (candidate) => candidate.collectorId === `extension:${integrationId}`,
      );
      if (!entry) throw new Error(`No catalogue entry for ${integrationId}`);
      return entry;
    };

    expect(catalogueAvailability(entryOf("acme-overlay"))).toBe("available");
    expect(catalogueAvailability(entryOf("acme-tracker"))).toBe("unavailable");
  });

  it("names the extensions that could not be asked in the report", () => {
    const report = buildPrivacyResponseReport({
      locale: "de",
      context: {
        request: {
          id: "r",
          kind: "access",
          receivedAt: "2026-01-01T00:00:00.000Z",
          registeredAt: "2026-01-01T00:01:00.000Z",
          preservationAt: null,
          snapshotAt: "2026-01-01T00:03:00.000Z",
        },
        generatedAt: "2026-01-02T00:00:00.000Z",
        controller: { name: "C", address: "A", email: "privacy@example.test", phone: null },
        deployment: {
          jurisdiction: "DE-BE",
          supervisoryAuthority: "Authority",
          supervisoryAuthorityUrl: null,
          privacySources: [],
          dsarCaseRetentionDays: 1095,
          backupRetentionDays: 30,
          serverLogRetentionDays: 30,
          auditLogRetentionDays: 365,
          adminJobRetentionDays: 30,
        },
        reviewContact: "privacy@example.test (case r)",
        recipientSummary: {
          entries: [],
          entryLimit: 100,
          truncated: false,
          totalGroupCount: 0,
          matchingEventCount: 0,
          archiveRecordCount: 0,
          summarizedAt: "2026-01-02T00:00:00.000Z",
          authoritativeSource: "openmapx-data-export/article-15/disclosures.jsonl",
        },
      },
      sources: [],
      extensions: [
        {
          integrationId: "acme-overlay",
          name: "Acme overlay",
          outcome: "included",
          warningCode: null,
        },
        {
          integrationId: "acme-tracker",
          name: "Acme tracker",
          outcome: "unavailable",
          warningCode: "extension-export-too-large",
        },
      ],
    });
    expect(report.text).toContain("Erweiterungen, die nicht gefragt werden konnten");
    expect(report.text).toContain("Acme tracker (acme-tracker)");
    expect(report.text).not.toContain("Acme overlay (acme-overlay)");
    expect(report.translationFallbacks).toEqual([]);
  });
});
