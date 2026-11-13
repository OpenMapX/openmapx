import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { inflateRawSync } from "node:zlib";
import {
  DAWARICH_EXPECTED_SCHEMA_FINGERPRINT,
  DAWARICH_SUPPORTED_COMMIT,
  DAWARICH_SUPPORTED_IMAGE_DIGEST,
} from "@openmapx/core/privacy";
import { and, eq } from "drizzle-orm";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/index.js";
import {
  account,
  dataDisclosureEvent,
  dataSubjectRequest,
  dataSubjectRequestEvent,
  personalTimelineConnection,
  savedList,
  session,
  sessionAuthAssurance,
  user,
} from "../db/schema.js";
import { tar } from "./__tests__/fixtures/source-tar.js";
import { SUBJECT_DATA_CATALOGUE } from "./catalogue.js";
import { EncryptedSourceSpool } from "./encrypted-source-spool.js";
import { PrivacyRequestService } from "./request-service.js";

const SUBJECT_ID = "controller-acceptance-subject";
const FOREIGN_ID = "controller-acceptance-foreign";
const SESSION_ID = "controller-acceptance-session";
const OPERATOR_SOURCES = SUBJECT_DATA_CATALOGUE.filter((r) => r.strategy === "operator_task").map(
  (r) => r.id,
);

const auth = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../auth.js", () => ({ auth: { api: { getSession: async () => auth.current } } }));

const { privacyRequestsRoute } = await import("../routes/privacy-requests.js");

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A managed Dawarich export; `pointBytes` makes the archive large enough to
 * interrupt mid-stream. */
function dawarichTar(subjectId: string, cutoff: string, pointBytes = 0): Buffer {
  const accountRow = Buffer.from('{"id":41,"email":"subject@example.test","role":"user"}\n');
  const pointLines = [
    '{"id":501,"timestamp":"2026-09-01T10:00:00.000Z","latitude":52.5,"longitude":13.4}',
  ];
  for (let id = 502; pointLines.join("\n").length < pointBytes; id += 1)
    pointLines.push(
      JSON.stringify({ id, note: randomBytes(512).toString("hex"), latitude: 52, longitude: 13 }),
    );
  const points = Buffer.from(`${pointLines.join("\n")}\n`);
  const declarations = [
    {
      id: "account",
      path: "dawarich/account.json",
      content: accountRow,
      records: 1,
      portability: false,
    },
    {
      id: "points-2026-09",
      path: "dawarich/points/2026/09.jsonl",
      content: points,
      records: pointLines.length,
      portability: true,
    },
  ];
  const manifest = Buffer.from(
    JSON.stringify({
      version: 1,
      image: "freikin/dawarich:1.19.0",
      imageDigest: DAWARICH_SUPPORTED_IMAGE_DIGEST,
      upstreamCommit: DAWARICH_SUPPORTED_COMMIT,
      subjectUserIdDigest: sha256(Buffer.from(subjectId)),
      collectorContract: "openmapx-subject-export-v1",
      cutoff,
      snapshotAt: "2026-09-04T00:00:00.000Z",
      schemaFingerprint: DAWARICH_EXPECTED_SCHEMA_FINGERPRINT,
      entries: declarations.map(({ id, content, records, portability }) => ({
        id,
        bytes: content.byteLength,
        sha256: sha256(content),
        records,
        article15: true,
        portability,
        redactionCodes: [],
      })),
      warnings: [],
    }),
  );
  return tar([
    ...declarations.map(({ path, content }) => [path, content] as [string, Buffer]),
    ["dawarich/source-manifest.json", manifest],
  ]);
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

async function seedSubject() {
  const createdAt = new Date("2026-09-01T00:00:00.000Z");
  await db.insert(user).values([
    {
      id: SUBJECT_ID,
      name: "Controller acceptance subject",
      email: "subject@example.test",
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: FOREIGN_ID,
      name: "FOREIGN-ADJACENT-RECORD",
      email: "foreign@example.test",
      createdAt,
      updatedAt: createdAt,
    },
  ]);
  await db.insert(account).values([
    {
      id: randomUUID(),
      accountId: "subject-account",
      providerId: "credential",
      userId: SUBJECT_ID,
      password: "FORBIDDEN-SUBJECT-CREDENTIAL",
      accessToken: "FORBIDDEN-SUBJECT-TOKEN",
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: randomUUID(),
      accountId: "foreign-account",
      providerId: "credential",
      userId: FOREIGN_ID,
      password: "FORBIDDEN-FOREIGN-CREDENTIAL",
      accessToken: "FORBIDDEN-FOREIGN-TOKEN",
      createdAt,
      updatedAt: createdAt,
    },
  ]);
  await db.insert(savedList).values([
    {
      id: "controller-acceptance-list",
      userId: SUBJECT_ID,
      name: "Subject hiking list",
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: "controller-acceptance-foreign-list",
      userId: FOREIGN_ID,
      name: "FOREIGN-SAVED-LIST",
      createdAt,
      updatedAt: createdAt,
    },
  ]);
  await db.insert(personalTimelineConnection).values({
    id: "controller-acceptance-timeline",
    userId: SUBJECT_ID,
    mode: "managed",
    publicOrigin: "https://timeline.example.test",
    displayName: "Managed timeline",
    encryptedApiKey: "FORBIDDEN-MANAGED-API-KEY",
    encryptionIv: "fixture-iv",
    encryptionTag: "fixture-tag",
    upstreamUserId: "41",
    upstreamEmail: "subject@example.test",
    upstreamTimeZone: "UTC",
    status: "connected",
    validatedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  });
  await db.insert(dataDisclosureEvent).values([
    {
      userId: SUBJECT_ID,
      occurredAt: new Date("2026-09-02T00:00:00.000Z"),
      recipientId: "route-processor",
      recipientName: "Acceptance Route Processor",
      recipientRole: "processor",
      recipientCountry: "DE",
      operationCode: "route-request",
      categoryCode: "location",
      purposeCode: "routing",
      legalBasisCode: "contract",
    },
    {
      userId: FOREIGN_ID,
      occurredAt: new Date("2026-09-02T00:00:00.000Z"),
      recipientId: "foreign-processor",
      recipientName: "FOREIGN-DISCLOSURE-RECIPIENT",
      recipientRole: "processor",
      operationCode: "route-request",
      categoryCode: "location",
      purposeCode: "routing",
      legalBasisCode: "contract",
    },
  ]);
  await db.insert(session).values({
    id: SESSION_ID,
    token: `token-${SESSION_ID}`,
    userId: SUBJECT_ID,
    expiresAt: new Date(Date.now() + 3_600_000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  auth.current = {
    user: { id: SUBJECT_ID, role: "user", twoFactorEnabled: false },
    session: { id: SESSION_ID, userId: SUBJECT_ID },
  };
}

async function signInFreshly(authenticatedAt = new Date()) {
  await db
    .insert(sessionAuthAssurance)
    .values({ sessionId: SESSION_ID, userId: SUBJECT_ID, method: "password", authenticatedAt })
    .onConflictDoUpdate({
      target: sessionAuthAssurance.sessionId,
      set: { authenticatedAt, method: "password" },
    });
}

async function exportApp(pointBytes = 0) {
  const app = Fastify();
  await app.register(privacyRequestsRoute, {
    prefix: "/api",
    database: db,
    exportSources: {
      openmapx: { offlinePrincipalKey: Buffer.alloc(32, 11) },
      dawarich: {
        fetchExport: async ({ request: source }) =>
          Readable.from([dawarichTar(SUBJECT_ID, source.cutoff, pointBytes)]),
      },
    },
  });
  return app;
}

async function subjectRequest() {
  const [row] = await db
    .select()
    .from(dataSubjectRequest)
    .where(eq(dataSubjectRequest.userId, SUBJECT_ID));
  return row;
}

async function eventTypes(requestId: string) {
  return (
    await db
      .select({ eventType: dataSubjectRequestEvent.eventType })
      .from(dataSubjectRequestEvent)
      .where(eq(dataSubjectRequestEvent.requestId, requestId))
  ).map((row) => row.eventType);
}

/**
 * Watch every source spool the export creates: where it lives, and that real
 * source data was written into it while the export ran.
 */
function watchSpools() {
  const spools: Array<{ directory: string; filesDuringExport: number }> = [];
  const original = EncryptedSourceSpool.create.bind(EncryptedSourceSpool);
  const spy = vi.spyOn(EncryptedSourceSpool, "create").mockImplementation(async (options) => {
    const spool = await original(options);
    const directory = (spool as unknown as { directory: string }).directory;
    const seen = { directory, filesDuringExport: 0 };
    spools.push(seen);
    const write = spool.write.bind(spool);
    spool.write = async (input) => {
      const entry = await write(input);
      seen.filesDuringExport = Math.max(seen.filesDuringExport, readdirSync(directory).length);
      return entry;
    };
    return spool;
  });
  return { spools, restore: () => spy.mockRestore() };
}

/** Every file below the test's temporary directory: the export may only use
 * the short-lived encrypted source spool, and must leave nothing behind. */
async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name);
}

let temporary: string;
beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), "openmapx-export-e2e-"));
  for (const [key, value] of Object.entries({
    TMPDIR: temporary,
    OPENMAPX_DEPLOYMENT_ID: "controller-acceptance",
    LEGAL_NAME: "Controller Acceptance Test",
    LEGAL_STREET: "Test Street 1",
    LEGAL_POSTAL_CODE: "10115",
    LEGAL_CITY: "Berlin",
    LEGAL_COUNTRY: "Germany",
    LEGAL_EMAIL: "privacy@example.test",
    LEGAL_DATA_REQUEST_EMAIL: "privacy@example.test",
    LEGAL_DEPLOYMENT_JURISDICTION: "DE-BE",
    LEGAL_SUPERVISORY_AUTHORITY: "Test Supervisory Authority",
    LEGAL_SUPERVISORY_AUTHORITY_URL: "https://authority.example.test/complaints",
    LEGAL_PRIVACY_SOURCES: "[]",
  }))
    vi.stubEnv(key, value);
  await db.delete(dataSubjectRequest).where(eq(dataSubjectRequest.userId, SUBJECT_ID));
  await db.delete(user).where(eq(user.id, SUBJECT_ID));
  await db.delete(user).where(eq(user.id, FOREIGN_ID));
  await seedSubject();
});

afterEach(async () => {
  auth.current = null;
  await db.delete(dataSubjectRequest).where(eq(dataSubjectRequest.userId, SUBJECT_ID));
  await db.delete(user).where(eq(user.id, SUBJECT_ID));
  await db.delete(user).where(eq(user.id, FOREIGN_ID));
  vi.unstubAllEnvs();
  await rm(temporary, { recursive: true, force: true });
});

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "self-service privacy export streamed on PostgreSQL",
  () => {
    it("refuses a session without a fresh sign-in and creates no request", async () => {
      const app = await exportApp();
      try {
        // An old sign-in is not fresh.
        await signInFreshly(new Date(Date.now() - 11 * 60_000));
        const response = await app.inject({
          method: "POST",
          url: "/api/privacy/export",
          payload: {},
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ code: "FRESH_SIGN_IN_REQUIRED" });
        expect(await subjectRequest()).toBeUndefined();
      } finally {
        await app.close();
      }
    });

    it("streams the full scope with the Article 15(1) information and stores nothing", async () => {
      const app = await exportApp();
      const watched = watchSpools();
      try {
        await signInFreshly();
        const response = await app.inject({
          method: "POST",
          url: "/api/privacy/export",
          payload: { kind: "access_and_portability", locale: "en", timeZone: "UTC" },
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.headers["content-type"]).toBe("application/zip");
        expect(response.headers["cache-control"]).toBe("private, no-store");
        expect(response.headers["content-disposition"]).toMatch(
          /^attachment; filename="openmapx-data-export-[0-9a-f]{8}\.zip"$/,
        );
        const members = zipMembers(response.rawPayload);
        const manifest = JSON.parse(
          members.get("openmapx-data-export/manifest.json")?.toString("utf8") ?? "null",
        ) as {
          request: { rights: { access: boolean; portability: boolean } };
          collectorOutcomes: Array<{ registrationId: string; outcome: string }>;
          members: Array<{ path: string; sha256: string }>;
        };
        // Full scope: every catalogue registration is accounted for, and the
        // operator-held sources are named as checked separately.
        const outcomes = new Map(
          manifest.collectorOutcomes.map((source) => [source.registrationId, source.outcome]),
        );
        expect([...outcomes.keys()].sort()).toEqual(
          SUBJECT_DATA_CATALOGUE.map((item) => item.id).sort(),
        );
        expect(outcomes.get("managed-dawarich")).toBe("included");
        for (const id of OPERATOR_SOURCES) expect(outcomes.get(id), id).toBe("operator_check");
        expect(manifest.request.rights).toEqual({ access: true, portability: true });
        for (const member of manifest.members)
          expect(sha256(members.get(member.path) as Buffer), member.path).toBe(member.sha256);
        // Article 15(1): purposes, categories, recipients, retention, source,
        // rights and the complaint authority are in the processing information.
        const information = JSON.parse(
          members
            .get("openmapx-data-export/article-15/processing-information.json")
            ?.toString("utf8") ?? "null",
        );
        expect(information).toMatchObject({
          version: 2,
          controller: { email: "privacy@example.test" },
          deployment: { supervisoryAuthority: "Test Supervisory Authority" },
          recipientSummary: { totalGroupCount: 1 },
        });
        const auth = information.sources.find(
          (source: { id: string }) => source.id === "auth-sessions",
        );
        expect(auth).toMatchObject({
          purposes: expect.any(Array),
          legalBases: expect.any(Array),
          retention: expect.any(Object),
          origin: expect.any(Object),
        });
        const readme = members.get("openmapx-data-export/README.txt")?.toString("utf8") ?? "";
        expect(readme).toContain("Checked separately by the operator");
        const archiveText = [...members.values()].map((value) => value.toString("utf8")).join("\n");
        expect(archiveText).toContain("Controller acceptance subject");
        expect(archiveText).toContain("Subject hiking list");
        expect(archiveText).toContain("Acceptance Route Processor");
        for (const forbidden of [
          "FOREIGN-ADJACENT-RECORD",
          "FOREIGN-SAVED-LIST",
          "FOREIGN-DISCLOSURE-RECIPIENT",
          "FORBIDDEN-SUBJECT-CREDENTIAL",
          "FORBIDDEN-SUBJECT-TOKEN",
          "FORBIDDEN-FOREIGN-CREDENTIAL",
          "FORBIDDEN-FOREIGN-TOKEN",
          "FORBIDDEN-MANAGED-API-KEY",
        ])
          expect(archiveText).not.toContain(forbidden);

        // The request is self-service, proven by the session, and stays in
        // progress while the operator-held sources are still open.
        const row = await subjectRequest();
        expect(row).toMatchObject({
          channel: "self_service",
          state: "in_progress",
          identityMethod: "account_session",
        });
        await vi.waitFor(async () =>
          expect(await eventTypes(row!.id)).toEqual(
            expect.arrayContaining([
              "received",
              "state_in_progress",
              "export_started",
              "export_delivered",
            ]),
          ),
        );
        // The sources really were spooled, encrypted, under the temporary
        // directory while the export ran (marker plus at least one member)...
        expect(watched.spools.length).toBeGreaterThan(0);
        for (const spool of watched.spools) {
          expect(spool.directory.startsWith(join(temporary, "openmapx-privacy-source-spool"))).toBe(
            true,
          );
          expect(spool.filesDuringExport).toBeGreaterThan(1);
          // ...and every spool is gone afterwards.
          expect(existsSync(spool.directory)).toBe(false);
        }
        // No archive was written anywhere: the temporary directory holds no file.
        expect(await filesUnder(temporary)).toEqual([]);

        // A second download reuses the same active request.
        const again = await app.inject({ method: "POST", url: "/api/privacy/export", payload: {} });
        expect(again.statusCode).toBe(200);
        expect(
          await db
            .select({ id: dataSubjectRequest.id })
            .from(dataSubjectRequest)
            .where(eq(dataSubjectRequest.userId, SUBJECT_ID)),
        ).toHaveLength(1);
      } finally {
        watched.restore();
        await app.close();
      }
    }, 60_000);

    it("lets a freshly signed-in owner verify and download an admin-created case linked to the account", async () => {
      vi.stubEnv("OPENMAPX_SECRETS_KEY", Buffer.alloc(32, 5).toString("hex"));
      const service = new PrivacyRequestService({ database: db });
      // An administrator recorded a postal request and linked it to the account.
      const assisted = await service.create({
        channel: "post",
        kind: "access_and_portability",
        userId: SUBJECT_ID,
        subject: { locatorType: "user_id", locator: SUBJECT_ID, accountState: "current" },
        locale: "en",
        timeZone: "UTC",
      });
      expect(assisted).toMatchObject({ state: "open", identityMethod: null });
      const app = await exportApp();
      try {
        await signInFreshly();
        const response = await app.inject({
          method: "POST",
          url: "/api/privacy/export",
          payload: {},
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.headers["content-type"]).toBe("application/zip");
        expect(zipMembers(response.rawPayload).has("openmapx-data-export/manifest.json")).toBe(
          true,
        );
        // The same case was used, verified by the session and moved into work.
        const row = await service.getById(assisted.id);
        expect(row).toMatchObject({
          channel: "post",
          state: "in_progress",
          identityMethod: "account_session",
        });
        expect(row.identityVerifiedAt).not.toBeNull();
        const events = await db
          .select({
            eventType: dataSubjectRequestEvent.eventType,
            payload: dataSubjectRequestEvent.payload,
          })
          .from(dataSubjectRequestEvent)
          .where(eq(dataSubjectRequestEvent.requestId, assisted.id));
        expect(events).toEqual(
          expect.arrayContaining([
            { eventType: "identity_verified", payload: { reasonCode: "account_session" } },
            {
              eventType: "state_in_progress",
              payload: { from: "open", reasonCode: "account_session" },
            },
            { eventType: "export_started", payload: {} },
          ]),
        );
        await vi.waitFor(async () =>
          expect(await eventTypes(assisted.id)).toContain("export_delivered"),
        );
        expect(
          await db
            .select({ id: dataSubjectRequest.id })
            .from(dataSubjectRequest)
            .where(eq(dataSubjectRequest.userId, SUBJECT_ID)),
        ).toHaveLength(1);
        // The account holder's own sign-in does not prove who sent the case, so
        // it never lets an administrator export the data to that requester.
        await expect(service.beginAdminExport(assisted.id, "admin-1")).rejects.toMatchObject({
          code: "MANUAL_IDENTITY_REQUIRED",
        });
      } finally {
        await app.close();
      }
    }, 60_000);

    it("returns a linked case that waits on the requester to work with the same verification", async () => {
      vi.stubEnv("OPENMAPX_SECRETS_KEY", Buffer.alloc(32, 5).toString("hex"));
      const service = new PrivacyRequestService({ database: db });
      const assisted = await service.create({
        channel: "email",
        kind: "access_and_portability",
        userId: SUBJECT_ID,
        subject: { locatorType: "user_id", locator: SUBJECT_ID, accountState: "current" },
        locale: "en",
        timeZone: "UTC",
      });
      const waiting = await service.recordDecision({
        requestId: assisted.id,
        version: assisted.version,
        decision: "waiting_on_requester",
        reasonCode: "asked-for-identity",
        actorId: "controller-acceptance-admin",
        idempotencyKey: `wait-${assisted.id}`,
      });
      expect(waiting.state).toBe("waiting_on_requester");
      const app = await exportApp();
      try {
        await signInFreshly();
        const response = await app.inject({
          method: "POST",
          url: "/api/privacy/export",
          payload: {},
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(await service.getById(assisted.id)).toMatchObject({
          state: "in_progress",
          identityMethod: "account_session",
        });
        expect(await eventTypes(assisted.id)).toEqual(
          expect.arrayContaining(["identity_verified", "state_in_progress"]),
        );
      } finally {
        await app.close();
      }
    }, 60_000);

    it("leaves the request in progress when the client aborts after the headers", async () => {
      const app = await exportApp(8 * 1024 * 1024);
      try {
        await signInFreshly();
        await app.listen({ port: 0, host: "127.0.0.1" });
        const { port } = app.server.address() as AddressInfo;
        const status = await new Promise<number>((resolve, reject) => {
          const outgoing = httpRequest(
            {
              host: "127.0.0.1",
              port,
              method: "POST",
              path: "/api/privacy/export",
              headers: { "content-type": "application/json" },
            },
            (incoming) => {
              incoming.once("data", () => {
                // Headers and the first bytes arrived; the client goes away.
                incoming.destroy();
                outgoing.destroy();
                resolve(incoming.statusCode ?? 0);
              });
            },
          );
          outgoing.on("error", () => undefined);
          outgoing.once("error", reject);
          outgoing.end(JSON.stringify({}));
        });
        expect(status).toBe(200);
        const row = await subjectRequest();
        await vi.waitFor(async () => expect(await eventTypes(row!.id)).toContain("export_failed"), {
          timeout: 20_000,
        });
        const events = await eventTypes(row!.id);
        expect(events).not.toContain("export_delivered");
        expect(events).not.toContain("state_completed");
        expect((await subjectRequest())?.state).toBe("in_progress");
        expect(
          await db
            .select({ id: dataSubjectRequestEvent.id })
            .from(dataSubjectRequestEvent)
            .where(
              and(
                eq(dataSubjectRequestEvent.requestId, row!.id),
                eq(dataSubjectRequestEvent.eventType, "export_failed"),
              ),
            ),
        ).toHaveLength(1);
        await vi.waitFor(async () => expect(await filesUnder(temporary)).toEqual([]));
      } finally {
        await app.close();
      }
    }, 60_000);
  },
);
