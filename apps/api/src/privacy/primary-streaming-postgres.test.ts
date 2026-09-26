import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import * as schema from "../db/schema.js";
import { account, savedList, user } from "../db/schema.js";
import { collectOpenMapxDataSnapshot, streamDrizzleRows } from "./openmapx-collectors.js";

const enabled = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1";
const connection = enabled ? postgres(process.env.DATABASE_URL as string, { max: 2 }) : null;
const database = connection ? drizzle(connection, { schema }) : null;

async function consume(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

afterAll(async () => {
  await connection?.end();
});

describe.skipIf(!enabled)("primary OpenMapX streaming snapshot", () => {
  it("pages real projections into replayable encrypted members with decoded field names", async () => {
    if (!database) throw new Error("database fixture is unavailable");
    const suffix = randomUUID();
    const subjectId = `primary-stream-${suffix}`;
    const foreignId = `primary-foreign-${suffix}`;
    const cutoffAt = new Date("2026-01-01T00:00:00.000Z");
    const before = new Date("2025-01-01T00:00:00.000Z");
    const after = new Date("2027-01-01T00:00:00.000Z");
    await database.insert(user).values([
      {
        id: subjectId,
        name: "Streaming Subject",
        email: `stream-${suffix}@example.test`,
        emailVerified: true,
        createdAt: before,
        updatedAt: before,
      },
      {
        id: foreignId,
        name: "Foreign Subject",
        email: `foreign-${suffix}@example.test`,
        createdAt: before,
        updatedAt: before,
      },
    ]);
    try {
      await database.insert(account).values([
        {
          id: `account-${suffix}`,
          accountId: `subject-${suffix}`,
          providerId: "credential",
          userId: subjectId,
          accessToken: "FORBIDDEN-PRIMARY-ACCESS-TOKEN",
          createdAt: before,
          updatedAt: before,
        },
        {
          id: `late-account-${suffix}`,
          accountId: `late-${suffix}`,
          providerId: "credential",
          userId: subjectId,
          createdAt: after,
          updatedAt: after,
        },
      ]);
      await database.insert(savedList).values([
        ...Array.from({ length: 300 }, (_, index) => ({
          id: `list-${index.toString().padStart(4, "0")}-${suffix}`,
          userId: subjectId,
          name: `List ${index.toString().padStart(4, "0")} ${suffix}`,
          createdAt: before,
          updatedAt: before,
        })),
        {
          id: `late-list-${suffix}`,
          userId: subjectId,
          name: `Late ${suffix}`,
          createdAt: after,
          updatedAt: after,
        },
        {
          id: `foreign-list-${suffix}`,
          userId: foreignId,
          name: `Foreign ${suffix}`,
          createdAt: before,
          updatedAt: before,
        },
      ]);

      const decodedProjection = [];
      for await (const row of streamDrizzleRows(
        database
          .select({
            identity: { subjectId: user.id },
            createdAt: user.createdAt,
            emailVerified: user.emailVerified,
            hasEmail: sql<boolean>`(${user.email} is not null)`,
          })
          .from(user)
          .where(eq(user.id, subjectId)) as never,
        database as never,
      ))
        decodedProjection.push(row);
      expect(decodedProjection).toEqual([
        {
          identity: { subjectId },
          createdAt: before,
          emailVerified: true,
          hasEmail: true,
        },
      ]);

      const snapshot = await collectOpenMapxDataSnapshot({
        userId: subjectId,
        cutoffAt,
        database: database as never,
        offlinePrincipalKey: Buffer.alloc(32, 7),
      });
      const savedPart = snapshot.parts.find((part) => part.registrationId === "saved-lists");
      const accountPart = snapshot.parts.find((part) => part.registrationId === "auth-accounts");
      expect(savedPart).toMatchObject({ recordCount: 300, outcome: "included", records: [] });
      expect(accountPart).toMatchObject({ recordCount: 1, outcome: "included", records: [] });

      const entries = snapshot.entries;
      const articleAccount = entries.find((entry) => entry.logicalId === "account");
      const authentication = entries.find((entry) => entry.logicalId === "authentication");
      const articleSaved = entries.find((entry) => entry.logicalId === "saved-content");
      const portableLists = entries.find((entry) => entry.logicalId === "portable-lists");
      if (!articleAccount || !authentication || !articleSaved || !portableLists)
        throw new Error("primary stream entry is missing");
      expect(articleAccount?.recordCount).toBe(1);
      expect(authentication?.recordCount).toBe(1);
      expect(articleSaved?.recordCount).toBe(300);
      expect(portableLists?.recordCount).toBe(300);

      const profile = JSON.parse(
        (await consume(articleAccount.source as AsyncIterable<Uint8Array>)).toString(),
      ) as Array<Record<string, unknown>>;
      expect(profile[0]).toMatchObject({
        registrationId: "account-profile",
        emailVerified: true,
        createdAt: before.toISOString(),
      });
      const authBytes = await consume(authentication.source as AsyncIterable<Uint8Array>);
      const auth = JSON.parse(authBytes.toString()) as Array<Record<string, unknown>>;
      expect(auth.find((row) => row.registrationId === "auth-accounts")).toMatchObject({
        hasAccessToken: true,
        createdAt: before.toISOString(),
      });
      expect(auth.find((row) => row.registrationId === "auth-accounts")).not.toHaveProperty(
        "issuer",
      );
      expect(authBytes.toString()).not.toContain("FORBIDDEN-PRIMARY-ACCESS-TOKEN");
      expect(authentication).toMatchObject({
        bytes: authBytes.byteLength,
        sha256: createHash("sha256").update(authBytes).digest("hex"),
        schemaId: "article-15-record-v1",
      });

      const savedLines = (await consume(articleSaved.source as AsyncIterable<Uint8Array>))
        .toString()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(savedLines).toHaveLength(300);
      expect(savedLines[0]).toMatchObject({
        registrationId: "saved-lists",
        sourceId: `list-0000-${suffix}`,
      });
      expect(savedLines.at(-1)).toMatchObject({ sourceId: `list-0299-${suffix}` });

      await snapshot.disposeSources?.();
      await expect(consume(articleSaved.source as AsyncIterable<Uint8Array>)).rejects.toMatchObject(
        { code: "ENOENT" },
      );

      const withoutProfile = await collectOpenMapxDataSnapshot({
        userId: subjectId,
        cutoffAt,
        database: database as never,
        offlinePrincipalKey: Buffer.alloc(32, 7),
        excludedRegistrationIds: new Set(["account-profile"]),
      });
      const withoutProfileEntries = withoutProfile.entries;
      expect(withoutProfileEntries.some((entry) => entry.logicalId === "account")).toBe(false);
      expect(withoutProfileEntries.some((entry) => entry.logicalId === "authentication")).toBe(
        true,
      );
      expect(withoutProfileEntries.some((entry) => entry.logicalId === "saved-content")).toBe(true);
      await withoutProfile.disposeSources?.();

      const withoutSaved = await collectOpenMapxDataSnapshot({
        userId: subjectId,
        cutoffAt,
        database: database as never,
        offlinePrincipalKey: Buffer.alloc(32, 7),
        excludedRegistrationIds: new Set(["saved-lists"]),
      });
      const withoutSavedEntries = withoutSaved.entries;
      expect(withoutSavedEntries.some((entry) => entry.logicalId === "saved-content")).toBe(false);
      expect(withoutSavedEntries.some((entry) => entry.logicalId === "portable-lists")).toBe(false);
      await withoutSaved.disposeSources?.();

      const spoolParent = await mkdtemp(join(tmpdir(), "openmapx-primary-limit-test-"));
      await expect(
        collectOpenMapxDataSnapshot({
          userId: subjectId,
          cutoffAt,
          database: database as never,
          offlinePrincipalKey: Buffer.alloc(32, 7),
          streamingLimits: { parentDirectory: spoolParent, maxRecords: 10 },
        }),
      ).rejects.toThrow("record limit");
      expect(await readdir(spoolParent)).toEqual([]);
    } finally {
      await database.delete(user).where(inArray(user.id, [subjectId, foreignId]));
    }
  }, 30_000);
});
