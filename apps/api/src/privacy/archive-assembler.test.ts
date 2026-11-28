import { readFile } from "node:fs/promises";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildSubjectArchiveEntries, renderReadmeHtml } from "./archive-assembler.js";
import { archivePathForLogicalId, PrivacyArchiveWriter } from "./archive-writer.js";
import type { PrivacyResponseContext } from "./response-report.js";

const responseContext: PrivacyResponseContext = {
  request: {
    id: "r",
    kind: "access_and_portability",
    receivedAt: "2026-01-01T00:00:00.000Z",
    registeredAt: "2026-01-01T00:01:00.000Z",
    preservationAt: "2026-01-01T00:02:00.000Z",
    snapshotAt: "2026-01-01T00:03:00.000Z",
  },
  generatedAt: "2026-01-02T00:00:00.000Z",
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
};

describe("subject archive assembler", () => {
  it("rejects duplicate source logical IDs instead of dropping a member", async () => {
    expect(() =>
      buildSubjectArchiveEntries({
        requestId: "r",
        locale: "en",
        generatedAt: "2026-01-01T00:00:00.000Z",
        responseContext,
        parts: ["one", "two"].map((registrationId) => ({
          registrationId,
          category: "timeline",
          outcome: "included" as const,
          warningCodes: [],
          capturedAt: "2026-01-01T00:00:00.000Z",
          records: [],
          entries: [
            {
              logicalId: "dawarich-account",
              source: Buffer.from("{}"),
              mediaType: "application/json",
              bytes: 2,
              sha256: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
            },
          ],
        })),
      }),
    ).toThrow("duplicate source logical ID");
  });

  it("files an extension's export under extensions/ by its integration id only", () => {
    expect(archivePathForLogicalId("extension:acme-overlay")).toBe(
      "openmapx-data-export/extensions/acme-overlay.json",
    );
    for (const logicalId of [
      "extension:",
      "extension:../manifest",
      "extension:Acme",
      "extension:a/b",
      "extension-acme-overlay",
    ])
      expect(archivePathForLogicalId(logicalId)).toBeNull();
  });

  it("lists every extension part in the manifest and writes the included ones", () => {
    const written = buildSubjectArchiveEntries({
      requestId: "r",
      locale: "en",
      responseContext,
      parts: [
        {
          registrationId: "extension:acme-overlay",
          category: "extension",
          outcome: "included",
          warningCodes: [],
          capturedAt: "2026-01-01T00:03:00.000Z",
          records: [],
          recordCount: 1,
          blocking: false,
          extension: { integrationId: "acme-overlay", name: "Acme overlay" },
          entries: [
            {
              logicalId: "extension:acme-overlay",
              source: Buffer.from('{"notes":[]}'),
              mediaType: "application/json",
            },
          ],
        },
        {
          registrationId: "extension:acme-tracker",
          category: "extension",
          outcome: "unavailable",
          warningCodes: ["extension-not-loaded"],
          capturedAt: "2026-01-01T00:03:00.000Z",
          records: [],
          recordCount: 0,
          blocking: false,
          extension: { integrationId: "acme-tracker", name: "Acme tracker" },
        },
      ],
    });
    const manifest = JSON.parse(
      (written.find((entry) => entry.logicalId === "manifest")?.source as Buffer).toString(),
    );
    expect(manifest.extensions).toEqual([
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
        warningCode: "extension-not-loaded",
      },
    ]);
    expect(manifest.members).toContainEqual(
      expect.objectContaining({
        logicalId: "extension:acme-overlay",
        path: "openmapx-data-export/extensions/acme-overlay.json",
      }),
    );
    expect(written.map((entry) => entry.logicalId)).not.toContain("extension:acme-tracker");
  });

  it("rejects an invalid generation timestamp before any byte is written", () => {
    expect(() =>
      buildSubjectArchiveEntries({
        requestId: "r",
        locale: "en",
        generatedAt: "invalid",
        responseContext,
        parts: [],
      }),
    ).toThrow("generation timestamp");
  });

  it("keeps Article 15 and portable projections separate and emits a static README", async () => {
    const entries = buildSubjectArchiveEntries({
      requestId: "r",
      locale: "en",
      responseContext,
      parts: [
        {
          registrationId: "saved-places",
          category: "saved-content",
          outcome: "included",
          warningCodes: [],
          capturedAt: "2024-01-01T00:00:00Z",
          records: [{ id: "1", portable: true, data: { name: "Home", coordinates: [13, 52] } }],
        },
      ],
    });
    const chunks: Buffer[] = [];
    const archive = await new PrivacyArchiveWriter().writeArchive({
      entries,
      sink: new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
      }),
    });
    const paths = archive.entries.map((entry) => entry.path);
    expect(paths).toContain("openmapx-data-export/README.html");
    expect(paths).toContain("openmapx-data-export/portable/saved-places.geojson");
    const zip = Buffer.concat(chunks);
    expect(zip.includes(Buffer.from("openmapx-data-export/README.html"))).toBe(true);
    expect(zip.includes(Buffer.from("openmapx-data-export/portable/saved-places.geojson"))).toBe(
      true,
    );
    expect(renderReadmeHtml("en")).toContain("default-src 'none'");
    expect(renderReadmeHtml("en")).not.toContain("<script");
  });

  it.each([
    [
      "access",
      ["authentication", "dawarich-account", "dawarich-settings"],
      ["portable-places", "dawarich-portable-areas"],
    ],
    [
      "portability",
      ["portable-places", "dawarich-portable-areas"],
      ["authentication", "dawarich-account", "dawarich-settings", "processing-information"],
    ],
    [
      "access_and_portability",
      [
        "authentication",
        "portable-places",
        "dawarich-account",
        "dawarich-portable-areas",
        "dawarich-settings",
      ],
      [],
    ],
  ] as const)(
    "gates %s archive members to the requested rights",
    async (kind, included, excluded) => {
      const written = buildSubjectArchiveEntries({
        requestId: "r",
        locale: "en",
        responseContext: { ...responseContext, request: { ...responseContext.request, kind } },
        parts: [
          {
            registrationId: "auth-sessions",
            category: "authentication",
            outcome: "included",
            warningCodes: [],
            capturedAt: "2026-01-01T00:03:00.000Z",
            records: [{ id: "auth", portable: false, data: {} }],
          },
          {
            registrationId: "saved-places",
            category: "saved-content",
            outcome: "included",
            warningCodes: [],
            capturedAt: "2026-01-01T00:03:00.000Z",
            records: [{ id: "place", portable: true, data: { coordinates: [13, 52] } }],
          },
        ],
        sourceEntries: [
          {
            logicalId: "dawarich-account",
            source: Buffer.from("{}"),
            mediaType: "application/json",
          },
          {
            logicalId: "dawarich-portable-areas",
            source: Buffer.from("{}"),
            mediaType: "application/jsonl",
          },
          {
            logicalId: "dawarich-settings",
            source: Buffer.from("{}"),
            mediaType: "application/json",
          },
        ],
      });
      expect(written.every((entry) => archivePathForLogicalId(entry.logicalId))).toBe(true);
      const logicalIds = written.map((entry) => entry.logicalId);
      for (const logicalId of included) expect(logicalIds).toContain(logicalId);
      for (const logicalId of excluded) expect(logicalIds).not.toContain(logicalId);
      const manifestEntry = written.find((entry) => entry.logicalId === "manifest");
      expect(manifestEntry?.source).toBeInstanceOf(Buffer);
      const manifest = JSON.parse((manifestEntry?.source as Buffer).toString());
      expect(manifest).toMatchObject({
        version: 1,
        request: { id: "r", kind },
        generatedAt: responseContext.generatedAt,
      });
      expect(manifest).not.toHaveProperty("expiresAt");
      expect(manifest.members.map((member: { logicalId: string }) => member.logicalId)).toEqual(
        logicalIds.filter((logicalId) => logicalId !== "manifest"),
      );
      const schemaOf = (logicalId: string) =>
        manifest.members.find((member: { logicalId: string }) => member.logicalId === logicalId)
          ?.schema;
      // Each member names the one schema it follows, or none.
      if (kind !== "portability") {
        expect(schemaOf("authentication")).toBe("export-record-1");
        expect(schemaOf("processing-information")).toBe("processing-information-1");
      }
      if (kind !== "access") expect(schemaOf("portable-places")).toBe("portable-places-1");
      expect(schemaOf("dawarich-account") ?? null).toBeNull();
      if (kind === "access_and_portability") {
        for (const [logicalId, filename, schemaId] of [
          ["manifest-schema", "export-manifest.schema.json", "export-manifest-1"],
          ["export-record-schema", "export-record.schema.json", "export-record-1"],
          ["portable-profile-schema", "portable-profile.schema.json", "portable-profile-1"],
          ["portable-places-schema", "portable-places.schema.json", "portable-places-1"],
          [
            "processing-information-schema",
            "processing-information.schema.json",
            "processing-information-1",
          ],
        ] as const) {
          const emitted = JSON.parse(
            (written.find((entry) => entry.logicalId === logicalId)?.source as Buffer).toString(),
          );
          const committed = JSON.parse(
            await readFile(new URL(`./schemas/${filename}`, import.meta.url), "utf8"),
          );
          expect(emitted).toEqual(committed);
          expect(emitted.$id).toBe(`urn:openmapx:privacy:${schemaId.replace(/-1$/, "")}:1`);
          expect(schemaOf(logicalId)).toBe(schemaId);
        }
        expect(logicalIds).not.toContain("category-schema");
      }
      if (kind === "portability") {
        const readme = written.find((entry) => entry.logicalId === "readme-text")?.source as Buffer;
        expect(readme.toString()).not.toContain("auth-sessions");
        expect(readme.toString()).not.toContain("privacy-case-records");
      }
    },
  );
});
