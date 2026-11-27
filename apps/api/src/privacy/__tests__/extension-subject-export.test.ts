import { Writable } from "node:stream";
import { inflateRawSync } from "node:zlib";
import { messages } from "@openmapx/i18n";
import type { LoadedIntegration, SubjectDataHandler } from "@openmapx/integration-framework";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentIntegrationScope } from "../../integration-scope";
import { archivePathForLogicalId } from "../archive-writer";
import { SUBJECT_DATA_CATALOGUE, subjectDataCatalogue } from "../catalogue";
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
    storesPersonalData?: boolean;
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
        : options.storesPersonalData
          ? {
              subjectData: {
                storesPersonalData: true,
                strategy: "operator_task",
                registrationIds: [],
                operatorInstructions: "Look in the extension's tables.",
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

/** A database whose only statements are the handler-table and schema reads. */
function databaseListing(listed: string[], schemas: string[] = []) {
  const client = vi.fn(async (strings: TemplateStringsArray) =>
    strings.join("").includes("pg_namespace")
      ? schemas.map((nspname) => ({ nspname }))
      : listed.map((integration_id) => ({ integration_id })),
  );
  return { $client: client } as unknown as NonNullable<
    Parameters<typeof prepareSubjectExport>[0]["database"]
  >;
}

async function exportArchive(
  listed: string[] = [],
  options: { schemas?: string[]; locale?: string; recordLeftOut?: (leftOut: unknown) => void } = {},
) {
  const prepared = await prepareSubjectExport({
    request: {
      id: "00000000-0000-7000-8000-000000000001",
      kind: "access_and_portability",
      locale: options.locale ?? "en",
      receivedAt: new Date("2026-01-01T00:00:00.000Z"),
      registeredAt: new Date("2026-01-01T00:01:00.000Z"),
      preservationAt: null,
      snapshotAt: new Date("2026-01-01T00:03:00.000Z"),
    },
    subjectUserId: "subject-1",
    database: databaseListing(listed, options.schemas),
    now: () => new Date("2026-01-02T00:00:00.000Z"),
    openmapx: {},
    ...(options.recordLeftOut
      ? { recordExtensionsLeftOut: async (leftOut) => options.recordLeftOut?.(leftOut) }
      : {}),
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
    prepared,
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
    schemas: string[] = [],
  ): Promise<CollectorSourcePart[]> {
    return collectExtensionParts({
      requestId: "case-1",
      userId: "subject-1",
      integrations: registry,
      listed: async () => listed,
      schemas: async () => schemas,
      log,
    });
  }

  const outcomes = (parts: CollectorSourcePart[]) =>
    parts.map((part) => [part.extension?.integrationId, part.outcome, part.warningCodes]);

  it("includes what a loaded extension returns, asked in its scope", async () => {
    let scope: string | undefined;
    const overlay = withHandler(integration("acme-overlay", "Acme overlay"), async (subjectId) => {
      scope = currentIntegrationScope()?.integrationId;
      return { subjectId, notes: [{ body: "x" }] };
    });

    const [part] = await partsFor([overlay]);

    expect(scope).toBe("acme-overlay");
    expect(part).toMatchObject({
      registrationId: "extension:acme-overlay",
      outcome: "included",
      warningCodes: [],
      blocking: false,
      extension: { integrationId: "acme-overlay", name: "Acme overlay" },
    });
    expect(JSON.parse(String(part?.entries?.[0]?.source))).toEqual({
      subjectId: "subject-1",
      notes: [{ body: "x" }],
    });
    expect(part?.entries?.[0]?.logicalId).toBe("extension:acme-overlay");
  });

  it("names nothing for an extension that holds no data about people", async () => {
    const parts = await partsFor(
      [
        integration("plain", "Plain"),
        integration("listed-loaded", "Listed, running, no handler"),
        integration("unlisted", "Not loaded, not listed", { loadState: "failed" }),
        integration("weather", "Built-in", { isBuiltIn: true, storesPersonalData: true }),
      ],
      ["listed-loaded"],
    );
    expect(parts).toEqual([]);
  });

  it("names a running extension that keeps personal data but registered no handler", async () => {
    const parts = await partsFor([
      integration("acme-cascade", "Acme cascade", { storesPersonalData: true }),
    ]);
    expect(outcomes(parts)).toEqual([
      ["acme-cascade", "unavailable", ["extension-no-export-handler"]],
    ]);
    expect(parts[0]).toMatchObject({ registrationId: "extension:acme-cascade", blocking: false });
  });

  it("names an extension that keeps personal data and cannot run, though it was never listed", async () => {
    const parts = await partsFor([
      integration("acme-trips", "Acme trips", { loadState: "failed", storesPersonalData: true }),
    ]);
    expect(outcomes(parts)).toEqual([["acme-trips", "unavailable", ["extension-not-loaded"]]]);
  });

  it("names a listed extension the registry does not hold, such as one uninstalled with its data kept", async () => {
    const parts = await partsFor([], ["gone-ext"]);
    expect(parts).toMatchObject([
      {
        registrationId: "extension:gone-ext",
        outcome: "unavailable",
        warningCodes: ["extension-not-installed"],
        blocking: false,
        extension: { integrationId: "gone-ext", name: "gone-ext" },
      },
    ]);
  });

  it("names every extension whose schema exists while it is not running, by the host's schema name", async () => {
    const asked = withHandler(integration("acme-notes", "Acme notes"), async () => ({}));
    const parts = await partsFor(
      [
        asked,
        integration("acme-off", "Acme off", { loadState: "disabled" }),
        integration("acme-plain", "Acme plain"),
      ],
      [],
      [
        "ext_acme_notes",
        "ext_acme_off",
        "ext_acme_plain",
        "ext_kept_data",
        "ext_trailing_",
        "ext__double",
        "ext_a__b",
        "ext_Upper",
      ],
    );
    expect(outcomes(parts)).toEqual([
      ["acme-notes", "included", []],
      ["acme-off", "unavailable", ["extension-not-loaded"]],
      ["kept-data", "unavailable", ["extension-not-installed"]],
    ]);
  });

  it("logs every part it leaves out with the case, the extension and the reason", async () => {
    await partsFor(
      [
        integration("acme-cascade", "Acme cascade", { storesPersonalData: true }),
        integration("acme-off", "Acme off", { loadState: "failed" }),
      ],
      ["acme-off", "gone-ext"],
    );
    expect(log.warn.mock.calls.map(([fields]) => fields)).toEqual([
      expect.objectContaining({
        requestId: "case-1",
        integrationId: "acme-cascade",
        warningCode: "extension-no-export-handler",
      }),
      expect.objectContaining({
        requestId: "case-1",
        integrationId: "acme-off",
        warningCode: "extension-not-loaded",
      }),
      expect.objectContaining({
        requestId: "case-1",
        integrationId: "gone-ext",
        warningCode: "extension-not-installed",
      }),
    ]);
  });

  it("writes an extension's name as one line of plain text", async () => {
    const [part] = await partsFor([
      integration("acme-cascade", "Acme\nFAKE LINE\r \u0007cascade", {
        storesPersonalData: true,
      }),
    ]);
    expect(part?.extension?.name).toBe("Acme FAKE LINE cascade");
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

  it("lists every listed extension and every extension schema as not loaded where no registry runs", async () => {
    const parts = await partsFor(null, ["acme-tracker"], ["ext_acme_tracker", "ext_acme_kept"]);
    expect(parts).toMatchObject([
      {
        registrationId: "extension:acme-kept",
        outcome: "unavailable",
        warningCodes: ["extension-not-loaded"],
        extension: { integrationId: "acme-kept", name: "acme-kept" },
      },
      {
        registrationId: "extension:acme-tracker",
        outcome: "unavailable",
        warningCodes: ["extension-not-loaded"],
        extension: { integrationId: "acme-tracker", name: "acme-tracker" },
      },
    ]);
  });

  it("does not collide with a catalogue entry for an extension whose id matches its name", async () => {
    const [part] = await partsFor([], ["erasure-pending"]);
    expect(part?.registrationId).toBe("extension:erasure-pending");
    expect(part?.registrationId).not.toBe("extension-erasure-pending");
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

    expect(outcomes(parts)).toEqual([
      ["acme-large", "unavailable", ["extension-export-too-large"]],
      ["acme-exact", "included", []],
    ]);
  });

  it("measures the JSON's bytes, not array indices or keys JSON leaves out", async () => {
    const zeros = withHandler(integration("acme-zeros", "Acme zeros"), async () =>
      new Array(1_200_000).fill(0),
    );
    const manyZeros = withHandler(integration("acme-many-zeros", "Acme many zeros"), async () =>
      new Array(4_500_000).fill(0),
    );
    const dropped: Record<string, unknown> = { pad: "x".repeat(MAX_EXTENSION_EXPORT_BYTES - 20) };
    for (let index = 0; index < 20_000; index += 1) dropped[`gone${index}`] = undefined;
    const sparse = withHandler(integration("acme-sparse", "Acme sparse"), async () => dropped);
    // Two bytes per character in UTF-8.
    const wide = withHandler(integration("acme-wide", "Acme wide"), async () =>
      "é".repeat(MAX_EXTENSION_EXPORT_BYTES / 2),
    );
    const narrow = withHandler(integration("acme-narrow", "Acme narrow"), async () =>
      "é".repeat(MAX_EXTENSION_EXPORT_BYTES / 2 - 1),
    );

    const parts = await partsFor([zeros, manyZeros, sparse, wide, narrow]);

    expect(outcomes(parts)).toEqual([
      ["acme-zeros", "included", []],
      ["acme-many-zeros", "unavailable", ["extension-export-too-large"]],
      ["acme-sparse", "included", []],
      ["acme-wide", "unavailable", ["extension-export-too-large"]],
      ["acme-narrow", "included", []],
    ]);
    expect(String(parts[0]?.entries?.[0]?.source)).toHaveLength(2_400_001);
  });

  it("stops writing a value once it is surely too large", async () => {
    let written = 0;
    const chunk = () => ({
      toJSON() {
        written += 1;
        return "x".repeat(4 * 1024 * 1024);
      },
    });
    const large = withHandler(integration("acme-large", "Acme large"), async () => [
      chunk(),
      chunk(),
      chunk(),
      chunk(),
    ]);

    const [part] = await partsFor([large]);

    expect(part?.warningCodes).toEqual(["extension-export-too-large"]);
    // Two chunks already pass 8 MiB; the other two are never written.
    expect(written).toBe(2);
  });

  it("writes an export that returns undefined as null", async () => {
    const nothing = withHandler(integration("acme-nothing", "Acme nothing"), async () => undefined);
    const [part] = await partsFor([nothing]);
    expect(part?.outcome).toBe("included");
    expect(String(part?.entries?.[0]?.source)).toBe("null");
  });

  it("runs an answer's toJSON in the extension's scope", async () => {
    let scope: string | undefined;
    const scoped = withHandler(integration("acme-scoped", "Acme scoped"), async () => ({
      toJSON() {
        scope = currentIntegrationScope()?.integrationId;
        return {};
      },
    }));
    await partsFor([scoped]);
    expect(scope).toBe("acme-scoped");
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

    const { read, manifest, prepared } = await exportArchive();

    expect(archivePathForLogicalId("extension:acme-overlay")).toBe(
      "openmapx-data-export/extensions/acme-overlay.json",
    );
    expect(archivePathForLogicalId("extension-acme-overlay")).toBeNull();
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
    expect(prepared.extensionsLeftOut).toEqual([]);
  });

  it.each(["en", "de"] as const)(
    "names the extensions it asked and the folder their answers are in (%s)",
    async (locale) => {
      const overlay = withHandler(integration("acme-overlay", "Acme overlay"), async () => ({}));
      setSubjectDataIntegrationSource(() => [overlay]);
      const t = messages[locale].privacyExport.report;

      const { read } = await exportArchive([], { locale });

      for (const readme of [read("README.txt") ?? "", read("README.html") ?? ""]) {
        expect(readme).toContain(t.extensionsIncludedHeading);
        expect(readme).toContain("Acme overlay (acme-overlay): extensions/acme-overlay.json");
      }
      expect(read("README.txt")).toContain(t.extensionsIncludedIntro);
    },
  );

  it.each(["en", "de"] as const)(
    "names every extension that may hold data the archive lacks, says the operator was asked, and has a task opened (%s)",
    async (locale) => {
      const cascade = integration("acme-cascade", "Acme cascade", { storesPersonalData: true });
      const tracker = integration("acme-tracker", "Acme tracker", { loadState: "safe-mode" });
      const broken = withHandler(integration("acme-broken", "Acme broken"), async () => {
        throw new Error("boom");
      });
      setSubjectDataIntegrationSource(() => [cascade, tracker, broken]);
      const recorded: unknown[] = [];
      const t = messages[locale].privacyExport.report;

      const { read, manifest, prepared } = await exportArchive(["acme-tracker", "gone-ext"], {
        locale,
        schemas: ["ext_kept_data"],
        recordLeftOut: (leftOut) => recorded.push(leftOut),
      });

      const leftOut = [
        { integrationId: "acme-cascade", warningCode: "extension-no-export-handler" },
        { integrationId: "acme-tracker", warningCode: "extension-not-loaded" },
        { integrationId: "acme-broken", warningCode: "extension-handler-failed" },
        { integrationId: "gone-ext", warningCode: "extension-not-installed" },
        { integrationId: "kept-data", warningCode: "extension-not-installed" },
      ];
      expect(prepared.extensionsLeftOut).toEqual(leftOut);
      expect(recorded).toEqual([leftOut]);
      for (const { integrationId, warningCode } of leftOut)
        expect(manifest.extensions).toContainEqual(
          expect.objectContaining({ integrationId, outcome: "unavailable", warningCode }),
        );
      for (const readme of [read("README.txt") ?? "", read("README.html") ?? ""]) {
        expect(readme).toContain(t.extensionsUnavailableHeading);
        expect(readme).toContain(t.extensionsUnavailableIntro);
        expect(readme).toContain(
          `Acme cascade (acme-cascade): ${t.warnings["extension-no-export-handler"]}`,
        );
        expect(readme).toContain(`gone-ext (gone-ext): ${t.warnings["extension-not-installed"]}`);
        expect(readme).toContain(`kept-data (kept-data): ${t.warnings["extension-not-installed"]}`);
      }
    },
  );

  it("refuses the export when the operator tasks for left-out extensions cannot be recorded", async () => {
    setSubjectDataIntegrationSource(() => [
      integration("acme-cascade", "Acme cascade", { storesPersonalData: true }),
    ]);
    await expect(
      exportArchive([], {
        recordLeftOut: () => {
          throw new Error("database unavailable");
        },
      }),
    ).rejects.toThrow("database unavailable");
  });

  it("keeps an extension named like a catalogue entry from answering for that entry", async () => {
    setSubjectDataIntegrationSource(() => [
      withHandler(integration("erasure-pending", "Erasure pending"), async () => ({})),
    ]);
    const { processing } = await exportArchive();
    expect(
      processing.sources.find(
        (source: { id: string }) => source.id === "extension-erasure-pending",
      ),
    ).toMatchObject({ outcome: "operator_check", recordCount: 0 });
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

  it("leaves out a declared entry that claims the data is not personal", () => {
    const warn = vi.fn();
    setSubjectDataIntegrationSource(
      () => [
        integration("acme-overlay", "Acme overlay", {
          registrations: [
            {
              ...NOTES_ENTRY,
              id: "acme-overlay-public",
              strategy: "not_personal",
              article15: "not_personal",
            },
          ],
        }),
      ],
      { warn },
    );
    expect(subjectDataCatalogue()).toEqual(SUBJECT_DATA_CATALOGUE);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: "acme-overlay",
        index: 0,
        problem: "an extension declares only personal data",
      }),
      expect.any(String),
    );
  });

  it("gives an operator-held entry no collector, so the report shows it as checked by the operator", async () => {
    const overlay = withHandler(
      integration("acme-overlay", "Acme overlay", {
        registrations: [
          {
            ...NOTES_ENTRY,
            id: "acme-overlay-backups",
            strategy: "operator_task",
            portability: { decision: "exclude", reasonCode: "operator-held" },
          },
        ],
      }),
      async () => ({ notes: [] }),
    );
    setSubjectDataIntegrationSource(() => [overlay]);

    const entry = subjectDataCatalogue().find(
      (candidate) => candidate.id === "acme-overlay-backups",
    );
    expect(entry).toMatchObject({ source: "extension", strategy: "operator_task" });
    expect(entry).not.toHaveProperty("collectorId");
    const { processing } = await exportArchive();
    expect(
      processing.sources.find((source: { id: string }) => source.id === "acme-overlay-backups"),
    ).toMatchObject({ outcome: "operator_check" });
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
    const unasked = report.text.slice(
      report.text.indexOf("Erweiterungen, die nicht gefragt werden konnten"),
    );
    expect(report.text).toContain("Erweiterungen, die nicht gefragt werden konnten");
    expect(unasked).toContain("Acme tracker (acme-tracker)");
    expect(unasked).not.toContain("Acme overlay (acme-overlay)");
    expect(report.text).toContain("Acme overlay (acme-overlay): extensions/acme-overlay.json");
    expect(report.translationFallbacks).toEqual([]);
  });
});
