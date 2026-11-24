import { randomBytes, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../../db/index.js";
import {
  accountActionReceipt,
  adminActionReauthentication,
  authPolicyApplication,
  dataDisclosureEvent,
  dataManagerOfflinePackageArtifactReferences,
  dataManagerOfflinePackageJobOwners,
  dataManagerOfflinePackageJobs,
  dataSubjectRequest,
  integrationApplicationReceipt,
  oauthAccessToken,
  oauthClient,
  oauthClientAssertion,
  oauthRefreshToken,
  parkedLocation,
  session,
  shareLink,
  user,
} from "../../db/schema.js";
import { PrivacyRequestService } from "../../privacy/request-service.js";
import { pruneDeclaredRetention } from "../declared-retention.js";
import { deriveOfflinePackagePrincipal } from "../offline-package-principal.js";

const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);
const users: string[] = [];
const requests: string[] = [];
const assertions: string[] = [];
const disclosures: string[] = [];
const accountReceipts: string[] = [];
const integrationReceipts: string[] = [];
const policyApplications: string[] = [];
const offlineJobs: string[] = [];
const offlinePrincipals: string[] = [];
const principalKey = randomBytes(32);

afterEach(async () => {
  if (assertions.length)
    await db.delete(oauthClientAssertion).where(inArray(oauthClientAssertion.id, assertions));
  if (disclosures.length)
    await db.delete(dataDisclosureEvent).where(inArray(dataDisclosureEvent.id, disclosures));
  if (accountReceipts.length)
    await db.delete(accountActionReceipt).where(inArray(accountActionReceipt.key, accountReceipts));
  if (integrationReceipts.length)
    await db
      .delete(integrationApplicationReceipt)
      .where(inArray(integrationApplicationReceipt.operationId, integrationReceipts));
  if (policyApplications.length)
    await db
      .delete(authPolicyApplication)
      .where(inArray(authPolicyApplication.key, policyApplications));
  if (offlinePrincipals.length)
    await db
      .delete(dataManagerOfflinePackageArtifactReferences)
      .where(inArray(dataManagerOfflinePackageArtifactReferences.principal, offlinePrincipals));
  if (offlineJobs.length)
    await db
      .delete(dataManagerOfflinePackageJobs)
      .where(inArray(dataManagerOfflinePackageJobs.id, offlineJobs));
  for (const id of requests)
    await db.delete(dataSubjectRequest).where(eq(dataSubjectRequest.id, id));
  for (const id of users) await db.delete(user).where(eq(user.id, id));
  for (const list of [
    users,
    requests,
    assertions,
    disclosures,
    accountReceipts,
    integrationReceipts,
    policyApplications,
    offlineJobs,
    offlinePrincipals,
  ])
    list.splice(0);
});

async function account(): Promise<string> {
  const id = randomUUID();
  users.push(id);
  await db.insert(user).values({
    id,
    name: "Retention fixture",
    email: `${id}@example.test`,
    updatedAt: new Date(),
  });
  return id;
}

const prune = (options: Parameters<typeof pruneDeclaredRetention>[0] = {}) =>
  pruneDeclaredRetention({ offlinePrincipalKey: async () => principalKey, ...options });

async function remaining<T>(rows: Promise<{ id: T }[]>): Promise<T[]> {
  return (await rows).map((row) => row.id).sort();
}

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "declared retention on PostgreSQL",
  () => {
    it("deletes sessions and administrator confirmations 30 days after they expire", async () => {
      const [owner, held] = [await account(), await account()];
      const insertSession = async (userId: string, expiredDaysAgo: number) => {
        const id = randomUUID();
        await db.insert(session).values({
          id,
          token: randomUUID(),
          userId,
          expiresAt: daysAgo(expiredDaysAgo),
          createdAt: daysAgo(expiredDaysAgo + 7),
          updatedAt: daysAgo(expiredDaysAgo + 7),
        });
        return id;
      };
      const insertConfirmation = async (actorId: string, expiredDaysAgo: number) => {
        const [row] = await db
          .insert(adminActionReauthentication)
          .values({
            actorId,
            startingSessionId: randomUUID(),
            purpose: "credentials.export",
            targetId: "credentials",
            nonceDigest: randomUUID(),
            expiresAt: daysAgo(expiredDaysAgo),
            createdAt: daysAgo(expiredDaysAgo),
          })
          .returning({ id: adminActionReauthentication.id });
        return row?.id ?? "";
      };
      const oldSession = await insertSession(owner, 31);
      const recentSession = await insertSession(owner, 29);
      const heldSession = await insertSession(held, 31);
      const oldConfirmation = await insertConfirmation(owner, 31);
      const recentConfirmation = await insertConfirmation(owner, 29);
      const heldConfirmation = await insertConfirmation(held, 31);
      await createHold(held);

      await prune();

      expect(
        await remaining(
          db
            .select({ id: session.id })
            .from(session)
            .where(inArray(session.id, [oldSession, recentSession, heldSession])),
        ),
      ).toEqual([recentSession, heldSession].sort());
      expect(
        await remaining(
          db
            .select({ id: adminActionReauthentication.id })
            .from(adminActionReauthentication)
            .where(
              inArray(adminActionReauthentication.id, [
                oldConfirmation,
                recentConfirmation,
                heldConfirmation,
              ]),
            ),
        ),
      ).toEqual([recentConfirmation, heldConfirmation].sort());
    });

    it("deletes OAuth tokens and client assertions 30 days after they expire", async () => {
      const [owner, held] = [await account(), await account()];
      const clientId = randomUUID();
      await db.insert(oauthClient).values({ id: randomUUID(), clientId, redirectUris: [] });
      const insertRefresh = async (userId: string, expiredDaysAgo: number) => {
        const id = randomUUID();
        await db.insert(oauthRefreshToken).values({
          id,
          token: randomUUID(),
          clientId,
          userId,
          expiresAt: daysAgo(expiredDaysAgo),
          createdAt: daysAgo(expiredDaysAgo + 1),
          scopes: ["openid"],
        });
        return id;
      };
      const insertAccess = async (userId: string | null, expiredDaysAgo: number) => {
        const id = randomUUID();
        await db.insert(oauthAccessToken).values({
          id,
          token: randomUUID(),
          clientId,
          userId,
          expiresAt: daysAgo(expiredDaysAgo),
          createdAt: daysAgo(expiredDaysAgo),
          scopes: ["openid"],
        });
        return id;
      };
      const insertAssertion = async (expiredDaysAgo: number) => {
        const id = randomUUID();
        assertions.push(id);
        await db.insert(oauthClientAssertion).values({ id, expiresAt: daysAgo(expiredDaysAgo) });
        return id;
      };
      const oldRefresh = await insertRefresh(owner, 31);
      const recentRefresh = await insertRefresh(owner, 29);
      const heldRefresh = await insertRefresh(held, 31);
      const oldAccess = await insertAccess(owner, 31);
      const oldClientAccess = await insertAccess(null, 31);
      const recentAccess = await insertAccess(owner, 29);
      const heldAccess = await insertAccess(held, 31);
      const oldAssertion = await insertAssertion(31);
      const recentAssertion = await insertAssertion(29);
      await createHold(held);

      await prune();

      try {
        expect(
          await remaining(
            db
              .select({ id: oauthRefreshToken.id })
              .from(oauthRefreshToken)
              .where(inArray(oauthRefreshToken.id, [oldRefresh, recentRefresh, heldRefresh])),
          ),
        ).toEqual([recentRefresh, heldRefresh].sort());
        expect(
          await remaining(
            db
              .select({ id: oauthAccessToken.id })
              .from(oauthAccessToken)
              .where(
                inArray(oauthAccessToken.id, [
                  oldAccess,
                  oldClientAccess,
                  recentAccess,
                  heldAccess,
                ]),
              ),
          ),
        ).toEqual([recentAccess, heldAccess].sort());
        expect(
          await remaining(
            db
              .select({ id: oauthClientAssertion.id })
              .from(oauthClientAssertion)
              .where(inArray(oauthClientAssertion.id, [oldAssertion, recentAssertion])),
          ),
        ).toEqual([recentAssertion]);
      } finally {
        await db.delete(oauthClient).where(eq(oauthClient.clientId, clientId));
      }
    });

    it("deletes disclosure records after three years", async () => {
      const [owner, held] = [await account(), await account()];
      const insertEvent = async (userId: string | null, days: number) => {
        const [row] = await db
          .insert(dataDisclosureEvent)
          .values({
            userId,
            occurredAt: daysAgo(days),
            recipientId: "retention-fixture",
            recipientName: "Retention fixture",
            recipientRole: "processor",
            operationCode: "fixture",
            categoryCode: "fixture",
            purposeCode: "fixture",
            legalBasisCode: "contract",
          })
          .returning({ id: dataDisclosureEvent.id });
        if (!row) throw new Error("Missing disclosure fixture");
        disclosures.push(row.id);
        return row.id;
      };
      const old = await insertEvent(owner, 1096);
      const oldErased = await insertEvent(null, 1096);
      const recent = await insertEvent(owner, 1094);
      const heldEvent = await insertEvent(held, 1096);
      await createHold(held);

      await prune();

      expect(
        await remaining(
          db
            .select({ id: dataDisclosureEvent.id })
            .from(dataDisclosureEvent)
            .where(inArray(dataDisclosureEvent.id, [old, oldErased, recent, heldEvent])),
        ),
      ).toEqual([recent, heldEvent].sort());
    });

    it("deletes administrative receipts after one year", async () => {
      const [owner, held] = [await account(), await account()];
      const integrationId = `retention-${randomUUID()}`;
      const insertReceipts = async (actorId: string, days: number) => {
        const key = randomUUID();
        accountReceipts.push(key);
        integrationReceipts.push(key);
        policyApplications.push(key);
        await db.insert(accountActionReceipt).values({
          key,
          actorId,
          action: "create",
          intentDigest: "fixture",
          createdAt: daysAgo(days),
        });
        await db.insert(integrationApplicationReceipt).values({
          operationId: key,
          actorId,
          integrationId,
          capability: "fixture",
          candidateId: randomUUID(),
          intentDigest: "fixture",
          savedBindingRevision: "fixture",
          result: {} as never,
          createdAt: daysAgo(days),
        });
        await db.insert(authPolicyApplication).values({
          key,
          actorId,
          intentDigest: "fixture",
          snapshot: {} as never,
          createdAt: daysAgo(days),
        });
        return key;
      };
      const old = await insertReceipts(owner, 366);
      const recent = await insertReceipts(owner, 364);
      const heldReceipt = await insertReceipts(held, 366);
      await createHold(held);

      await prune();

      const keys = [old, recent, heldReceipt];
      const expected = [recent, heldReceipt].sort();
      expect(
        await remaining(
          db
            .select({ id: accountActionReceipt.key })
            .from(accountActionReceipt)
            .where(inArray(accountActionReceipt.key, keys)),
        ),
      ).toEqual(expected);
      expect(
        await remaining(
          db
            .select({ id: integrationApplicationReceipt.operationId })
            .from(integrationApplicationReceipt)
            .where(inArray(integrationApplicationReceipt.operationId, keys)),
        ),
      ).toEqual(expected);
      expect(
        await remaining(
          db
            .select({ id: authPolicyApplication.key })
            .from(authPolicyApplication)
            .where(inArray(authPolicyApplication.key, keys)),
        ),
      ).toEqual(expected);
    });

    it("keeps the newest receipt for each integration and each account whatever its age", async () => {
      const [actor, target, heldTarget] = [await account(), await account(), await account()];
      const integrationId = `retention-${randomUUID()}`;
      const insertIntegrationReceipt = async (days: number) => {
        const key = randomUUID();
        integrationReceipts.push(key);
        await db.insert(integrationApplicationReceipt).values({
          operationId: key,
          actorId: actor,
          integrationId,
          capability: "fixture",
          candidateId: randomUUID(),
          intentDigest: "fixture",
          savedBindingRevision: "fixture",
          result: {} as never,
          createdAt: daysAgo(days),
        });
        return key;
      };
      const insertAccountReceipt = async (targetId: string, days: number) => {
        const key = randomUUID();
        accountReceipts.push(key);
        await db.insert(accountActionReceipt).values({
          key,
          actorId: actor,
          targetId,
          action: "role",
          intentDigest: "fixture",
          createdAt: daysAgo(days),
        });
        return key;
      };
      const olderIntegration = await insertIntegrationReceipt(500);
      const newestIntegration = await insertIntegrationReceipt(400);
      const olderAccount = await insertAccountReceipt(target, 500);
      const newestAccount = await insertAccountReceipt(target, 400);
      // Held only through its target: the actor has no open request.
      const heldThroughTarget = await insertAccountReceipt(heldTarget, 500);
      const newestForHeldTarget = await insertAccountReceipt(heldTarget, 400);
      await createHold(heldTarget);

      await prune();

      expect(
        await remaining(
          db
            .select({ id: integrationApplicationReceipt.operationId })
            .from(integrationApplicationReceipt)
            .where(
              inArray(integrationApplicationReceipt.operationId, [
                olderIntegration,
                newestIntegration,
              ]),
            ),
        ),
      ).toEqual([newestIntegration]);
      expect(
        await remaining(
          db
            .select({ id: accountActionReceipt.key })
            .from(accountActionReceipt)
            .where(
              inArray(accountActionReceipt.key, [
                olderAccount,
                newestAccount,
                heldThroughTarget,
                newestForHeldTarget,
              ]),
            ),
        ),
      ).toEqual([newestAccount, heldThroughTarget, newestForHeldTarget].sort());
    });

    it("deletes share links and parked locations 30 days after they expire", async () => {
      const insertShare = async (userId: string, expiredDaysAgo: number | null) => {
        const [row] = await db
          .insert(shareLink)
          .values({
            userId,
            tokenHash: randomUUID(),
            targetType: "route",
            mode: "snapshot",
            label: "A → B",
            snapshot: {},
            createdAt: daysAgo(60),
            expiresAt: expiredDaysAgo === null ? null : daysAgo(expiredDaysAgo),
          })
          .returning({ id: shareLink.id });
        return row?.id ?? "";
      };
      const insertParked = async (userId: string, expiredDaysAgo: number | null) => {
        const [row] = await db
          .insert(parkedLocation)
          .values({
            userId,
            lat: 52.5,
            lng: 13.4,
            source: "manual",
            savedAt: daysAgo(60),
            expiresAt: expiredDaysAgo === null ? null : daysAgo(expiredDaysAgo),
          })
          .returning({ id: parkedLocation.id });
        return row?.id ?? "";
      };
      const [oldOwner, recentOwner, lastingOwner, held] = [
        await account(),
        await account(),
        await account(),
        await account(),
      ];
      const oldShare = await insertShare(oldOwner, 31);
      const recentShare = await insertShare(recentOwner, 29);
      const lastingShare = await insertShare(lastingOwner, null);
      const heldShare = await insertShare(held, 31);
      const oldParked = await insertParked(oldOwner, 31);
      const recentParked = await insertParked(recentOwner, 29);
      const lastingParked = await insertParked(lastingOwner, null);
      const heldParked = await insertParked(held, 31);
      await createHold(held);

      await prune();

      expect(
        await remaining(
          db
            .select({ id: shareLink.id })
            .from(shareLink)
            .where(inArray(shareLink.id, [oldShare, recentShare, lastingShare, heldShare])),
        ),
      ).toEqual([recentShare, lastingShare, heldShare].sort());
      expect(
        await remaining(
          db
            .select({ id: parkedLocation.id })
            .from(parkedLocation)
            .where(
              inArray(parkedLocation.id, [oldParked, recentParked, lastingParked, heldParked]),
            ),
        ),
      ).toEqual([recentParked, lastingParked, heldParked].sort());
    });

    it("deletes offline-package rows of accounts that no longer exist 30 days after they were recorded", async () => {
      const live = deriveOfflinePackagePrincipal(await account(), principalKey);
      const erased = randomBytes(32).toString("hex");
      offlinePrincipals.push(live, erased);
      const insertOwner = async (principal: string, days: number) => {
        const jobId = randomUUID();
        offlineJobs.push(jobId);
        await db.insert(dataManagerOfflinePackageJobs).values({
          id: jobId,
          requestKey: randomUUID(),
          packageId: `pkg-${jobId}`,
          request: {},
          status: "failed",
          createdAt: daysAgo(days),
          updatedAt: daysAgo(days),
        });
        await db
          .insert(dataManagerOfflinePackageJobOwners)
          .values({ jobId, principal, createdAt: daysAgo(days) });
        return jobId;
      };
      const insertReference = async (principal: string, days: number) => {
        const packageId = `pkg-${randomUUID()}`;
        await db.insert(dataManagerOfflinePackageArtifactReferences).values({
          principal,
          packageId,
          byteLength: 1,
          retainedAt: daysAgo(days),
        });
        return `${principal}:${packageId}`;
      };
      const oldErasedJob = await insertOwner(erased, 31);
      const recentErasedJob = await insertOwner(erased, 29);
      const oldLiveJob = await insertOwner(live, 31);
      const oldErasedRef = await insertReference(erased, 31);
      const recentErasedRef = await insertReference(erased, 29);
      const oldLiveRef = await insertReference(live, 31);

      await prune();

      expect(
        await remaining(
          db
            .select({ id: dataManagerOfflinePackageJobOwners.jobId })
            .from(dataManagerOfflinePackageJobOwners)
            .where(
              inArray(dataManagerOfflinePackageJobOwners.jobId, [
                oldErasedJob,
                recentErasedJob,
                oldLiveJob,
              ]),
            ),
        ),
      ).toEqual([recentErasedJob, oldLiveJob].sort());
      const references = await db
        .select({
          principal: dataManagerOfflinePackageArtifactReferences.principal,
          packageId: dataManagerOfflinePackageArtifactReferences.packageId,
        })
        .from(dataManagerOfflinePackageArtifactReferences)
        .where(inArray(dataManagerOfflinePackageArtifactReferences.principal, [live, erased]));
      expect(references.map((row) => `${row.principal}:${row.packageId}`).sort()).toEqual(
        [recentErasedRef, oldLiveRef].sort(),
      );
      expect(references.map((row) => `${row.principal}:${row.packageId}`)).not.toContain(
        oldErasedRef,
      );

      // Without the key no principal can be matched to an account, so nothing
      // is deleted.
      await insertOwner(erased, 40);
      const before = await db
        .select({ id: dataManagerOfflinePackageJobOwners.jobId })
        .from(dataManagerOfflinePackageJobOwners)
        .where(eq(dataManagerOfflinePackageJobOwners.principal, erased));
      await pruneDeclaredRetention({ offlinePrincipalKey: async () => undefined });
      const after = await db
        .select({ id: dataManagerOfflinePackageJobOwners.jobId })
        .from(dataManagerOfflinePackageJobOwners)
        .where(eq(dataManagerOfflinePackageJobOwners.principal, erased));
      expect(after.length).toBe(before.length);

      // An unreadable key file fails the run visibly and deletes nothing.
      const unreadable = new Error("Offline package principal key is unreadable");
      const failed = await pruneDeclaredRetention({
        offlinePrincipalKey: async () => {
          throw unreadable;
        },
      }).catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(AggregateError);
      expect((failed as AggregateError).errors).toContain(unreadable);
      const afterFailure = await db
        .select({ id: dataManagerOfflinePackageJobOwners.jobId })
        .from(dataManagerOfflinePackageJobOwners)
        .where(eq(dataManagerOfflinePackageJobOwners.principal, erased));
      expect(afterFailure.length).toBe(before.length);
    });

    it("reaches every orphaned offline-package row however many live principals sort before it", async () => {
      const live = await Promise.all(
        [1, 2, 3, 4, 5].map(async () =>
          deriveOfflinePackagePrincipal(await account(), principalKey),
        ),
      );
      const erased = randomBytes(32).toString("hex");
      offlinePrincipals.push(...live, erased);
      for (const principal of [...live, erased])
        await db.insert(dataManagerOfflinePackageArtifactReferences).values({
          principal,
          packageId: `pkg-${randomUUID()}`,
          byteLength: 1,
          retainedAt: daysAgo(40),
        });

      // One principal per page and a single batch per table for the other
      // rules: the orphan scan still walks to the end.
      await prune({ batchSize: 1, maxBatches: 1 });

      const principals = await db
        .select({ principal: dataManagerOfflinePackageArtifactReferences.principal })
        .from(dataManagerOfflinePackageArtifactReferences)
        .where(inArray(dataManagerOfflinePackageArtifactReferences.principal, [...live, erased]));
      expect(principals.map((row) => row.principal).sort()).toEqual([...live].sort());
    });

    it("deletes in bounded batches and stops after the batch limit", async () => {
      const ids: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const id = randomUUID();
        ids.push(id);
        assertions.push(id);
        await db.insert(oauthClientAssertion).values({ id, expiresAt: daysAgo(40) });
      }
      const count = async () =>
        (
          await db
            .select({ id: oauthClientAssertion.id })
            .from(oauthClientAssertion)
            .where(inArray(oauthClientAssertion.id, ids))
        ).length;

      // Older assertions left by other tests may be deleted first; at most
      // two rows go in this run.
      const limited = await prune({ batchSize: 1, maxBatches: 2 });
      expect(limited.oauth_client_assertion).toBe(2);
      expect(await count()).toBeGreaterThanOrEqual(3);

      const full = await prune({ batchSize: 2 });
      expect(full.oauth_client_assertion).toBeGreaterThanOrEqual(1);
      expect(await count()).toBe(0);
    });
  },
);

/** Opens an access request for the account, which holds the rows it already has. */
async function createHold(userId: string): Promise<void> {
  const request = await new PrivacyRequestService({ database: db }).create({
    userId,
    kind: "access",
    channel: "self_service",
    locale: "en",
    timeZone: "UTC",
  });
  requests.push(request.id);
}
