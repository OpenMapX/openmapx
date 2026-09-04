import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleSubjectArchive } from "../../../apps/api/src/privacy/archive-assembler.js";
import { EncryptedBlobStore } from "../../../apps/api/src/privacy/artifact-storage.js";
import { PrivacyArchiveWriter } from "../../../apps/api/src/privacy/artifact-writer.js";
import { spoolBackupSourceTar } from "../../../apps/api/src/privacy/backup-source-part.js";
import { loadMasterKeyRing } from "../../../apps/api/src/privacy/crypto.js";

async function main(): Promise<void> {
  const tarPath = process.argv[2];
  if (!tarPath) throw new Error("backup tar path is required");
  const root = await mkdtemp(join(tmpdir(), "openmapx-backup-api-fixture-"));
  const rssBefore = process.memoryUsage().rss;
  const reference = "a".repeat(64);
  try {
    const spooled = await spoolBackupSourceTar(createReadStream(tarPath), { namespace: reference });
    const logicalIds = new Set(spooled.entries.map((entry) => entry.logicalId));
    for (const required of [
      `backup-${reference}-openmapx-account-profile`,
      `backup-${reference}-dawarich-areas`,
      `backup-${reference}-dawarich-attachments`,
      `backup-${reference}-source-manifest`,
    ]) {
      if (!logicalIds.has(required)) throw new Error(`API parser omitted ${required}`);
    }
    for (const entry of spooled.entries) {
      if (entry.mediaType === "application/jsonl" && entry.schemaId !== "backup-history-record-v1")
        throw new Error(`historical JSONL has an incompatible schema: ${entry.logicalId}`);
    }
    const ring = loadMasterKeyRing({
      env: {
        NODE_ENV: "development",
        OPENMAPX_EXPORTS_KEY: Buffer.alloc(32, 23).toString("base64url"),
      },
    });
    const store = new EncryptedBlobStore({ root, ring, deploymentId: "backup-fixture" });
    const archive = await assembleSubjectArchive({
      requestId: "00000000-0000-4000-8000-000000000001",
      artifactId: "00000000-0000-4000-8000-000000000002",
      locale: "en",
      parts: [
        {
          registrationId: "backup-retained-copies",
          category: "backup-copies",
          records: [],
          entries: spooled.entries,
          disposeSources: spooled.dispose,
          outcome: "included",
          warningCodes: spooled.warnings,
          capturedAt: "2026-09-04T09:00:00.000Z",
        },
      ],
      writer: new PrivacyArchiveWriter(store),
      generatedAt: "2026-09-04T09:00:00.000Z",
      responseContext: {
        request: {
          id: "00000000-0000-4000-8000-000000000001",
          kind: "access_and_portability",
          receivedAt: "2026-09-04T00:00:00.000Z",
          registeredAt: "2026-09-04T00:01:00.000Z",
          preservationAt: "2026-09-04T00:02:00.000Z",
          snapshotAt: "2026-09-04T00:03:00.000Z",
        },
        generatedAt: "2026-09-04T09:00:00.000Z",
        expiresAt: "2026-09-11T09:00:00.000Z",
        controller: {
          name: "Fixture Controller",
          address: "Fixture Street 1\n10115 Berlin\nGermany",
          email: "privacy@example.test",
          phone: null,
        },
        deployment: {
          jurisdiction: "DE-BE",
          supervisoryAuthority: "Fixture Authority",
          supervisoryAuthorityUrl: null,
          privacySources: [],
          dsarCaseRetentionDays: 1095,
          identityEvidenceRetentionDays: 30,
          exportArtifactRetentionHours: 168,
        },
        reviewContact: "privacy@example.test",
        recipientSummary: {
          entries: [],
          entryLimit: 100,
          truncated: false,
          totalGroupCount: 0,
          matchingEventCount: 0,
          archiveRecordCount: 0,
          summarizedAt: "2026-09-04T09:00:00.000Z",
          authoritativeSource: "openmapx-data-export/article-15/disclosures.jsonl",
        },
      },
    });
    if (!archive.entryPaths.some((path) => path.includes(`/history/${reference}/openmapx/`)))
      throw new Error("encrypted assembler omitted namespaced OpenMapX history");
    if (!archive.entryPaths.some((path) => path.includes(`/history/${reference}/dawarich/`)))
      throw new Error("encrypted assembler omitted namespaced Dawarich history");
    if (
      !archive.entryPaths.includes("openmapx-data-export/schemas/backup-history-record.schema.json")
    )
      throw new Error("encrypted assembler omitted the historical record schema");
    if (!archive.entryPaths.includes("openmapx-data-export/schemas/backup-source.schema.json"))
      throw new Error("encrypted assembler omitted the historical source schema");
    const ciphertext = await readFile(archive.path);
    const sentinels = [
      "FOREIGN_ROW_SENTINEL",
      "PASSWORD_SENTINEL",
      "ACCESS_TOKEN_SENTINEL",
      "REFRESH_TOKEN_SENTINEL",
      "ID_TOKEN_SENTINEL",
      "NESTED_SECRET_SENTINEL",
      "SHARE_CAPABILITY_SENTINEL",
    ];
    for (const sentinel of sentinels)
      if (ciphertext.includes(Buffer.from(sentinel)))
        throw new Error(`ciphertext leaked ${sentinel}`);
    const chunks: Buffer[] = [];
    await store.decryptTo(archive, (chunk) => chunks.push(Buffer.from(chunk)));
    const zip = join(root, "fixture.zip");
    await writeFile(zip, Buffer.concat(chunks));
    const plaintext = spawnSync("unzip", ["-p", zip], { maxBuffer: 64 * 1024 * 1024 });
    if (plaintext.status !== 0) throw new Error("assembled ZIP could not be inspected");
    for (const sentinel of sentinels)
      if (plaintext.stdout.includes(Buffer.from(sentinel)))
        throw new Error(`assembled archive leaked ${sentinel}`);
    if (!plaintext.stdout.includes(Buffer.from("timeline@example.test")))
      throw new Error("assembled archive omitted subject Dawarich data");
    const rssGrowth = process.memoryUsage().rss - rssBefore;
    if (rssGrowth > 192 * 1024 * 1024)
      throw new Error(`API parser/assembler RSS grew by ${rssGrowth} bytes`);
    process.stdout.write("privacy backup API encrypted assembly fixture passed\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
