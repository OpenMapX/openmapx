import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assembleSubjectArchive, renderReadmeHtml } from "./archive-assembler.js";
import { EncryptedBlobStore } from "./artifact-storage.js";
import { archivePathForLogicalId, PrivacyArchiveWriter } from "./artifact-writer.js";
import { loadMasterKeyRing } from "./crypto.js";
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
  expiresAt: "2026-01-09T00:00:00.000Z",
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
    identityEvidenceRetentionDays: 30,
    exportArtifactRetentionHours: 168,
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
    await expect(
      assembleSubjectArchive({
        requestId: "r",
        artifactId: "a",
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
        writer: { writeArchive: vi.fn(async () => ({ entries: [] })) } as never,
      }),
    ).rejects.toThrow("duplicate source logical ID");
  });

  it("disposes transient source storage when validation fails before writing", async () => {
    const disposeSources = vi.fn(async () => undefined);
    await expect(
      assembleSubjectArchive({
        requestId: "r",
        artifactId: "a",
        locale: "en",
        generatedAt: "invalid",
        responseContext,
        parts: [
          {
            registrationId: "managed-dawarich",
            category: "timeline",
            outcome: "included",
            warningCodes: [],
            capturedAt: "2026-01-01T00:00:00.000Z",
            records: [],
            disposeSources,
          },
        ],
        writer: { writeArchive: vi.fn() } as never,
      }),
    ).rejects.toThrow("generation timestamp");
    expect(disposeSources).toHaveBeenCalledOnce();
  });

  it("keeps Article 15 and portable projections separate and emits a static README", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmapx-assemble-test-"));
    const ring = loadMasterKeyRing({
      env: {
        NODE_ENV: "development",
        OPENMAPX_EXPORTS_KEY: Buffer.alloc(32, 5).toString("base64url"),
      },
    });
    const store = new EncryptedBlobStore({ root, ring, deploymentId: "test" });
    const archive = await assembleSubjectArchive({
      requestId: "r",
      artifactId: "a",
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
      writer: new PrivacyArchiveWriter(store),
    });
    expect(archive.entryPaths).toContain("openmapx-data-export/README.html");
    expect(archive.entryPaths).toContain("openmapx-data-export/portable/saved-places.geojson");
    const chunks: Buffer[] = [];
    await store.decryptTo(archive, (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    expect(renderReadmeHtml("en")).toContain("default-src 'none'");
    expect(renderReadmeHtml("en")).not.toContain("<script");
    expect((await readFile(archive.path)).toString()).not.toContain("Home");
  });

  it.each([
    [
      "access",
      [
        "authentication",
        "dawarich-account",
        "supplement-1",
        `backup-${"a".repeat(64)}-openmapx-auth-sessions`,
      ],
      [
        "portable-places",
        "dawarich-portable-areas",
        `backup-${"a".repeat(64)}-openmapx-portable-saved-lists`,
      ],
    ],
    [
      "portability",
      [
        "portable-places",
        "dawarich-portable-areas",
        `backup-${"a".repeat(64)}-openmapx-portable-saved-lists`,
      ],
      [
        "authentication",
        "dawarich-account",
        "supplement-1",
        "processing-information",
        `backup-${"a".repeat(64)}-openmapx-auth-sessions`,
      ],
    ],
    [
      "access_and_portability",
      [
        "authentication",
        "portable-places",
        "dawarich-account",
        "dawarich-portable-areas",
        "supplement-1",
        `backup-${"a".repeat(64)}-openmapx-auth-sessions`,
        `backup-${"a".repeat(64)}-openmapx-portable-saved-lists`,
      ],
      [],
    ],
  ] as const)(
    "gates %s archive members to the requested rights",
    async (kind, included, excluded) => {
      let written: Array<{ logicalId: string; source: unknown }> = [];
      const writer = {
        writeArchive: vi.fn(async ({ entries }: { entries: typeof written }) => {
          written = entries;
          return {
            storageKey: "test",
            path: "/tmp/test",
            plaintextBytes: 1,
            ciphertextBytes: 1,
            plaintextSha256: "a".repeat(64),
            ciphertextSha256: "b".repeat(64),
            iv: "iv",
            tag: "tag",
            wrappedDek: {},
            masterKeyVersion: 1,
            entries: entries.map((entry) => ({
              logicalId: entry.logicalId,
              path: archivePathForLogicalId(entry.logicalId) ?? "",
            })),
          };
        }),
      };
      await assembleSubjectArchive({
        requestId: "r",
        artifactId: "a",
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
            logicalId: "supplement-1",
            source: Buffer.from("x"),
            mediaType: "application/octet-stream",
          },
          {
            logicalId: `backup-${"a".repeat(64)}-openmapx-auth-sessions`,
            source: Buffer.from("{}"),
            mediaType: "application/jsonl",
          },
          {
            logicalId: `backup-${"a".repeat(64)}-openmapx-portable-saved-lists`,
            source: Buffer.from("{}"),
            mediaType: "application/jsonl",
          },
        ],
        writer: writer as never,
      });
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
        expiresAt: responseContext.expiresAt,
      });
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
