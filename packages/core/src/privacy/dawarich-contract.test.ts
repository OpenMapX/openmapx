import { describe, expect, it } from "vitest";
import {
  DAWARICH_EXPECTED_SCHEMA_FINGERPRINT,
  DAWARICH_SOURCE_PATHS,
  DAWARICH_SUPPORTED_COMMIT,
  DAWARICH_SUPPORTED_IMAGE_DIGEST,
  dawarichEntryIdForPath,
  dawarichSourceManifestV1Schema,
  dawarichSourcePathForEntryId,
  dawarichSubjectRequestV1Schema,
  isDawarichPortableEntryId,
  isSupportedDawarichRuntime,
} from "./dawarich-contract";

describe("managed Dawarich contract", () => {
  it("accepts only the bounded protocol request", () => {
    const value = dawarichSubjectRequestV1Schema.parse({
      version: 1,
      requestId: "00000000-0000-4000-8000-000000000001",
      openmapxSubjectId: "user-1",
      expectedDawarichUserId: null,
      cutoff: "2026-01-01T00:00:00Z",
      rights: ["access", "portability"],
    });
    expect(value.version).toBe(1);
    expect(() => dawarichSubjectRequestV1Schema.parse({ ...value, extra: true })).toThrow();
    expect(() =>
      dawarichSubjectRequestV1Schema.parse({ ...value, rights: ["access", "access"] }),
    ).toThrow();
  });

  it("maps only fixed source paths", () => {
    expect(dawarichEntryIdForPath(DAWARICH_SOURCE_PATHS.account)).toBe("account");
    expect(dawarichEntryIdForPath("../secrets.txt")).toBeNull();
    expect(dawarichEntryIdForPath("dawarich/import-files/x.bin")).toBeNull();
    const importId = `import-file-${"a".repeat(64)}.json` as const;
    expect(dawarichEntryIdForPath(`dawarich/import-files/${"a".repeat(64)}.json`)).toBe(importId);
    expect(dawarichSourcePathForEntryId(importId)).toBe(
      `dawarich/import-files/${"a".repeat(64)}.json`,
    );
    expect(dawarichEntryIdForPath("dawarich/points/2026/13.jsonl")).toBeNull();
    expect(dawarichEntryIdForPath("dawarich/points/2026/09.jsonl")).toBe("points-2026-09");
    expect(isDawarichPortableEntryId(importId)).toBe(true);
    expect(isDawarichPortableEntryId("source-manifest")).toBe(false);
  });

  it("rejects compatibility drift", () => {
    const base = {
      version: 1,
      image: "freikin/dawarich:1.10.3",
      imageDigest: DAWARICH_SUPPORTED_IMAGE_DIGEST,
      upstreamCommit: DAWARICH_SUPPORTED_COMMIT,
      subjectUserIdDigest: "a".repeat(64),
      cutoff: "2026-01-01T00:00:00Z",
      snapshotAt: "2026-01-01T00:00:00Z",
      schemaFingerprint: DAWARICH_EXPECTED_SCHEMA_FINGERPRINT,
      collectorContract: "openmapx-subject-export-v1",
      entries: [],
      warnings: [],
    };
    expect(dawarichSourceManifestV1Schema.parse(base).version).toBe(1);
    expect(() =>
      dawarichSourceManifestV1Schema.parse({ ...base, upstreamCommit: "b".repeat(40) }),
    ).toThrow();
    expect(() =>
      dawarichSourceManifestV1Schema.parse({
        ...base,
        schemaFingerprint: "b".repeat(64),
      }),
    ).toThrow();
    expect(
      isSupportedDawarichRuntime({
        image: base.image,
        digest: base.imageDigest,
        commit: base.upstreamCommit,
      }),
    ).toBe(true);
    expect(
      isSupportedDawarichRuntime({
        image: base.image,
        digest: base.imageDigest,
        commit: "b".repeat(40),
      }),
    ).toBe(false);
  });

  it("accepts only content-addressed dynamic members", () => {
    const base = {
      version: 1 as const,
      image: "freikin/dawarich:1.10.3",
      imageDigest: DAWARICH_SUPPORTED_IMAGE_DIGEST,
      upstreamCommit: DAWARICH_SUPPORTED_COMMIT,
      subjectUserIdDigest: "a".repeat(64),
      cutoff: "2026-01-01T00:00:00Z",
      snapshotAt: "2026-01-01T00:00:00Z",
      schemaFingerprint: DAWARICH_EXPECTED_SCHEMA_FINGERPRINT,
      collectorContract: "openmapx-subject-export-v1",
      entries: [
        {
          id: `import-file-${"b".repeat(64)}.json`,
          bytes: 1,
          sha256: "c".repeat(64),
          records: null,
          article15: true,
          portability: true,
          redactionCodes: [],
        },
      ],
      warnings: [],
    };
    expect(dawarichSourceManifestV1Schema.parse(base).entries).toHaveLength(1);
    expect(() =>
      dawarichSourceManifestV1Schema.parse({
        ...base,
        entries: [{ ...base.entries[0], id: "import-file-../../secret.bin" }],
      }),
    ).toThrow();
  });
});
