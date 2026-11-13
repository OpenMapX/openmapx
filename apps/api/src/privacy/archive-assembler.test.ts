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
        version: 2,
        request: { id: "r", kind },
        generatedAt: responseContext.generatedAt,
      });
      expect(manifest).not.toHaveProperty("expiresAt");
      expect(manifest.members.map((member: { logicalId: string }) => member.logicalId)).toEqual(
        logicalIds.filter((logicalId) => logicalId !== "manifest"),
      );
      if (kind === "access_and_portability") {
        for (const [logicalId, filename] of [
          ["manifest-schema", "export-manifest.schema.json"],
          ["processing-information-schema", "processing-information.schema.json"],
        ] as const) {
          const emitted = JSON.parse(
            (written.find((entry) => entry.logicalId === logicalId)?.source as Buffer).toString(),
          );
          const committed = JSON.parse(
            await readFile(new URL(`./schemas/${filename}`, import.meta.url), "utf8"),
          );
          expect(emitted).toEqual(committed);
        }
      }
      if (kind === "portability") {
        const readme = written.find((entry) => entry.logicalId === "readme-text")?.source as Buffer;
        expect(readme.toString()).not.toContain("auth-sessions");
        expect(readme.toString()).not.toContain("privacy-case-records");
      }
    },
  );
});
