import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { db as defaultDb } from "../db/index.js";
import {
  account,
  adminAuditLog,
  adminJob,
  dataDisclosureEvent,
  dataExportReauthentication,
  dataManagerOfflinePackageArtifactReferences,
  dataManagerOfflinePackageJobOwners,
  dataManagerOfflinePackageJobs,
  dataSubjectRequest,
  dataSubjectRequestBackupReview,
  dataSubjectRequestEmailChallenge,
  dataSubjectRequestEvent,
  dataSubjectRequestIdentity,
  dataSubjectRequestNotification,
  dataSubjectRequestTask,
  installedExtension,
  installedIntegration,
  integrationSecret,
  labeledPlace,
  mangroveKeypair,
  mangroveKeypairWrap,
  mobileAuthHandoff,
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  parkedLocation,
  passkey,
  personalTimelineConnection,
  personalVehicle,
  savedList,
  savedPlace,
  serviceSecret,
  session,
  shareLink,
  systemSettings,
  twoFactor,
  user,
  verification,
} from "../db/schema.js";
import { deriveOfflinePackagePrincipal } from "../services/offline-package-principal.js";
import { getSubjectDataRegistration, SUBJECT_DATA_CATALOGUE } from "./catalogue.js";
import {
  type CollectorSourcePart,
  type CollectorSourcePartEntry,
  includedPart,
  projectSubjectRecord,
  type SubjectExportRecord,
  stableRecordId,
} from "./collectors.js";
import { EncryptedSourceSpool } from "./encrypted-source-spool.js";
import { encodeGeoJson, encodeJsonArray, encodeJsonLines } from "./primary-source-stream.js";

export interface OpenMapxCollectorContext {
  userId: string;
  /** Trusted current case ID, supplied only by generation after identity review. */
  requestId?: string;
  /** Purpose-bound keyed digests for exact historical user-ID cases whose
   * nullable user FK was cleared by account erasure. */
  subjectLocatorDigests?: readonly string[];
  cutoffAt: Date;
  database?: typeof defaultDb;
  offlinePrincipalKey?: Buffer;
  snapshotAt?: Date;
  excludedRegistrationIds?: ReadonlySet<string>;
  /** Durable receipt-side safe projections replace live rows that may have
   * expired before generation. Each iterable is consumed at most once. */
  receiptSnapshotOverrides?: ReadonlyMap<string, AsyncIterable<SubjectExportRecord>>;
  receiptSnapshotCapturedAt?: ReadonlyMap<string, Date>;
  streamingLimits?: {
    parentDirectory?: string;
    maxMemberBytes?: number;
    maxTotalBytes?: number;
    maxFiles?: number;
    maxRecords?: number;
  };
}

type QueryDb = typeof defaultDb;
const PRIMARY_QUERY_PAGE_SIZE = 256;
const TEST_MATERIALIZATION_RECORD_LIMIT = 10_000;

interface DrizzleCursorQuery<T> extends PromiseLike<T[]> {
  toSQL(): { sql: string; params: unknown[] };
  _prepare?: () => {
    client: {
      unsafe(
        query: string,
        parameters: unknown[],
      ): {
        values(): { cursor(pageSize: number): AsyncIterable<unknown[][]> };
      };
    };
    queryString: string;
    params: unknown[];
    fields: Array<{
      path: string[];
      field: {
        mapFromDriverValue?: (value: unknown) => unknown;
        decoder?: { mapFromDriverValue(value: unknown): unknown };
        sql?: { decoder?: { mapFromDriverValue(value: unknown): unknown } };
      };
    }>;
  };
}

type TypedRow = Record<string, unknown>;

function mapPreparedRow<T extends TypedRow>(
  fields: NonNullable<ReturnType<NonNullable<DrizzleCursorQuery<T>["_prepare"]>>>["fields"],
  row: unknown[],
): T {
  const result: Record<string, unknown> = {};
  for (const [index, selected] of fields.entries()) {
    const raw = row[index];
    let value = raw;
    if (raw !== null) {
      if (typeof selected.field.mapFromDriverValue === "function")
        value = selected.field.mapFromDriverValue(raw);
      else {
        const decoder = selected.field.decoder ?? selected.field.sql?.decoder;
        if (decoder) value = decoder.mapFromDriverValue(raw);
      }
    }
    let target = result;
    for (const [pathIndex, path] of selected.path.entries()) {
      if (pathIndex === selected.path.length - 1) target[path] = value;
      else {
        const child = target[path];
        if (!child || typeof child !== "object") target[path] = {};
        target = target[path] as Record<string, unknown>;
      }
    }
  }
  return result as T;
}

/** Stream a projected Drizzle query with postgres.js' transaction-bound cursor.
 * The fallback exists for focused query-builder fixtures; production snapshot
 * collection always supplies the Postgres transaction session. */
export async function* streamDrizzleRows<T extends TypedRow>(
  query: DrizzleCursorQuery<T>,
  _database: QueryDb,
): AsyncGenerator<T> {
  const prepared = query._prepare?.();
  if (prepared) {
    for await (const page of prepared.client
      .unsafe(prepared.queryString, prepared.params)
      .values()
      .cursor(PRIMARY_QUERY_PAGE_SIZE)) {
      for (const row of page) yield mapPreparedRow<T>(prepared.fields, row);
    }
    return;
  }
  // Query-builder fixtures do not expose Drizzle's prepared projection mapper.
  // Await them normally rather than returning unmapped driver column names.
  for (const row of await query) yield row;
}

function dbOf(context: OpenMapxCollectorContext): QueryDb {
  return context.database ?? defaultDb;
}
function pseudonymousIdentifier(value: unknown): string | null {
  return typeof value === "string" && value.length > 0
    ? stableRecordId("privacy-identifier", value)
    : null;
}
function safeShareSnapshot(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const allowed = ["targetType", "label", "createdAt", "expiresAt", "mode", "title", "description"];
  const result = Object.fromEntries(
    allowed
      .filter((key) => {
        const candidate = source[key];
        return (
          candidate === null ||
          typeof candidate === "string" ||
          typeof candidate === "number" ||
          typeof candidate === "boolean"
        );
      })
      .map((key) => [key, source[key]]),
  );
  // A share snapshot can contain a recipient or another user's object ID.
  // Keep the fact that a target existed, but never disclose the opaque foreign
  // identifier.  The digest is deterministic within the export and therefore
  // still lets a subject correlate repeated references without making the ID
  // useful outside the case.
  if (source.targetId !== undefined && source.targetId !== null) {
    const targetDigest = pseudonymousIdentifier(source.targetId);
    if (targetDigest) result.targetIdDigest = targetDigest;
  }
  return result;
}
function safeAuditDetails(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const allowed = [
    "operation",
    "resource",
    "status",
    "reasonCode",
    "serviceId",
    "integrationId",
    "createdAt",
  ];
  return Object.fromEntries(
    allowed
      .filter((key) => {
        const candidate = source[key];
        return (
          candidate === null ||
          typeof candidate === "string" ||
          typeof candidate === "number" ||
          typeof candidate === "boolean"
        );
      })
      .map((key) => [key, source[key]]),
  );
}

type ProjectedRow = Record<string, unknown>;

async function* projectedRows(
  database: QueryDb,
  query: DrizzleCursorQuery<ProjectedRow>,
  category: string,
  options: {
    portable?: boolean;
    policyCodes?: string[];
    map?: (row: ProjectedRow) => Record<string, unknown>;
  } = {},
): AsyncGenerator<ReturnType<typeof projectSubjectRecord>> {
  for await (const row of streamDrizzleRows(query, database)) {
    yield projectSubjectRecord(
      category,
      options.map?.(row) ?? row,
      options.portable ?? false,
      options.policyCodes,
    );
  }
}

/** Ownership-first production projections consumed through the transaction's
 * fixed-size postgres cursor pages. */
export async function* streamOpenMapxRegistrationRecords(
  registrationId: string,
  context: OpenMapxCollectorContext,
): AsyncGenerator<ReturnType<typeof projectSubjectRecord>> {
  const receiptSnapshot = context.receiptSnapshotOverrides?.get(registrationId);
  if (receiptSnapshot) {
    for await (const record of receiptSnapshot) yield record;
    return;
  }
  const registration = getSubjectDataRegistration(registrationId);
  if (registration?.strategy !== "collector") return;
  const database = dbOf(context);
  const category = registration.category;
  const cutoff = context.cutoffAt;
  const emit = (
    query: unknown,
    options?: Parameters<typeof projectedRows>[3],
  ): AsyncGenerator<ReturnType<typeof projectSubjectRecord>> =>
    projectedRows(database, query as DrizzleCursorQuery<ProjectedRow>, category, options);

  switch (registrationId) {
    case "account-profile":
      yield* emit(
        database
          .select({
            id: user.id,
            name: user.name,
            email: user.email,
            emailVerified: user.emailVerified,
            image: user.image,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
            role: user.role,
            banned: user.banned,
            banReason: user.banReason,
            banExpires: user.banExpires,
            normalizedEmail: user.normalizedEmail,
            twoFactorEnabled: user.twoFactorEnabled,
          })
          .from(user)
          .where(and(eq(user.id, context.userId), lte(user.createdAt, cutoff)))
          .orderBy(asc(user.id)),
        { portable: true },
      );
      return;
    case "auth-accounts":
      yield* emit(
        database
          .select({
            id: account.id,
            issuer: account.issuer,
            accountId: account.accountId,
            providerId: account.providerId,
            scope: account.scope,
            accessTokenExpiresAt: account.accessTokenExpiresAt,
            refreshTokenExpiresAt: account.refreshTokenExpiresAt,
            createdAt: account.createdAt,
            updatedAt: account.updatedAt,
            hasAccessToken: sql<boolean>`(${account.accessToken} is not null)`,
            hasRefreshToken: sql<boolean>`(${account.refreshToken} is not null)`,
            hasIdToken: sql<boolean>`(${account.idToken} is not null)`,
            hasPassword: sql<boolean>`(${account.password} is not null)`,
          })
          .from(account)
          .where(and(eq(account.userId, context.userId), lte(account.createdAt, cutoff)))
          .orderBy(asc(account.id)),
        { policyCodes: ["credential-redacted", "secret-presence-only"] },
      );
      return;
    case "auth-sessions":
      yield* emit(
        database
          .select({
            id: session.id,
            expiresAt: session.expiresAt,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            ipAddress: session.ipAddress,
            userAgent: session.userAgent,
            impersonatedBy: session.impersonatedBy,
          })
          .from(session)
          .where(and(eq(session.userId, context.userId), lte(session.createdAt, cutoff)))
          .orderBy(asc(session.id)),
        {
          policyCodes: ["session-token-redacted"],
          map: ({ id, ...row }) => ({ sessionDigest: pseudonymousIdentifier(id), ...row }),
        },
      );
      return;
    case "auth-passkeys":
      yield* emit(
        database
          .select({
            id: passkey.id,
            name: passkey.name,
            publicKey: passkey.publicKey,
            credentialID: passkey.credentialID,
            counter: passkey.counter,
            deviceType: passkey.deviceType,
            backedUp: passkey.backedUp,
            transports: passkey.transports,
            createdAt: passkey.createdAt,
            aaguid: passkey.aaguid,
          })
          .from(passkey)
          .where(
            and(
              eq(passkey.userId, context.userId),
              or(sql`${passkey.createdAt} is null`, lte(passkey.createdAt, cutoff)),
            ),
          )
          .orderBy(asc(passkey.id)),
        { policyCodes: ["authentication-key-metadata"] },
      );
      return;
    case "auth-two-factor":
      yield* emit(
        database
          .select({
            id: twoFactor.id,
            verified: twoFactor.verified,
            failedVerificationCount: twoFactor.failedVerificationCount,
            lockedUntil: twoFactor.lockedUntil,
          })
          .from(twoFactor)
          .where(eq(twoFactor.userId, context.userId))
          .orderBy(asc(twoFactor.id)),
        { policyCodes: ["authentication-secret"], map: (row) => ({ enabled: true, ...row }) },
      );
      return;
    case "auth-verifications":
      yield* emit(
        database
          .select({
            id: verification.id,
            identifier: verification.identifier,
            expiresAt: verification.expiresAt,
            createdAt: verification.createdAt,
            updatedAt: verification.updatedAt,
          })
          .from(verification)
          .innerJoin(user, eq(verification.identifier, user.email))
          .where(and(eq(user.id, context.userId), lte(verification.createdAt, cutoff)))
          .orderBy(asc(verification.id)),
        { policyCodes: ["challenge-redacted"] },
      );
      return;
    case "auth-oauth-resources": {
      const policies = ["oauth-secret-redacted", "opaque-identifier-redacted"];
      const digestTokenIds = ({ id, clientId, sessionId, referenceId, ...row }: ProjectedRow) => ({
        ...row,
        resourceIdDigest: pseudonymousIdentifier(id),
        clientIdDigest: pseudonymousIdentifier(clientId),
        sessionIdDigest: pseudonymousIdentifier(sessionId),
        referenceIdDigest: pseudonymousIdentifier(referenceId),
      });
      yield* emit(
        database
          .select({
            id: oauthClient.id,
            clientId: oauthClient.clientId,
            clientDiscoveryId: oauthClient.clientDiscoveryId,
            disabled: oauthClient.disabled,
            createdAt: oauthClient.createdAt,
            updatedAt: oauthClient.updatedAt,
            name: oauthClient.name,
            uri: oauthClient.uri,
            scopes: oauthClient.scopes,
            redirectUris: oauthClient.redirectUris,
          })
          .from(oauthClient)
          .where(
            and(
              eq(oauthClient.userId, context.userId),
              or(sql`${oauthClient.createdAt} is null`, lte(oauthClient.createdAt, cutoff)),
            ),
          )
          .orderBy(asc(oauthClient.id)),
        {
          policyCodes: policies,
          map: ({ id, clientId, clientDiscoveryId, ...row }) => ({
            ...row,
            resourceIdDigest: pseudonymousIdentifier(id),
            clientIdDigest: pseudonymousIdentifier(clientId),
            clientDiscoveryIdDigest: pseudonymousIdentifier(clientDiscoveryId),
          }),
        },
      );
      yield* emit(
        database
          .select({
            id: oauthRefreshToken.id,
            clientId: oauthRefreshToken.clientId,
            sessionId: oauthRefreshToken.sessionId,
            referenceId: oauthRefreshToken.referenceId,
            resources: oauthRefreshToken.resources,
            expiresAt: oauthRefreshToken.expiresAt,
            createdAt: oauthRefreshToken.createdAt,
            revoked: oauthRefreshToken.revoked,
            scopes: oauthRefreshToken.scopes,
          })
          .from(oauthRefreshToken)
          .where(
            and(
              eq(oauthRefreshToken.userId, context.userId),
              lte(oauthRefreshToken.createdAt, cutoff),
            ),
          )
          .orderBy(asc(oauthRefreshToken.id)),
        { policyCodes: policies, map: digestTokenIds },
      );
      yield* emit(
        database
          .select({
            id: oauthAccessToken.id,
            clientId: oauthAccessToken.clientId,
            sessionId: oauthAccessToken.sessionId,
            referenceId: oauthAccessToken.referenceId,
            resources: oauthAccessToken.resources,
            expiresAt: oauthAccessToken.expiresAt,
            createdAt: oauthAccessToken.createdAt,
            revoked: oauthAccessToken.revoked,
            scopes: oauthAccessToken.scopes,
          })
          .from(oauthAccessToken)
          .where(
            and(
              eq(oauthAccessToken.userId, context.userId),
              lte(oauthAccessToken.createdAt, cutoff),
            ),
          )
          .orderBy(asc(oauthAccessToken.id)),
        { policyCodes: policies, map: digestTokenIds },
      );
      yield* emit(
        database
          .select({
            id: oauthConsent.id,
            clientId: oauthConsent.clientId,
            referenceId: oauthConsent.referenceId,
            resources: oauthConsent.resources,
            scopes: oauthConsent.scopes,
            createdAt: oauthConsent.createdAt,
            updatedAt: oauthConsent.updatedAt,
          })
          .from(oauthConsent)
          .where(and(eq(oauthConsent.userId, context.userId), lte(oauthConsent.createdAt, cutoff)))
          .orderBy(asc(oauthConsent.id)),
        { policyCodes: policies, map: digestTokenIds },
      );
      return;
    }
    case "saved-lists":
      yield* emit(
        database
          .select({
            id: savedList.id,
            name: savedList.name,
            icon: savedList.icon,
            isPrivate: savedList.isPrivate,
            sortOrder: savedList.sortOrder,
            createdAt: savedList.createdAt,
            updatedAt: savedList.updatedAt,
          })
          .from(savedList)
          .where(and(eq(savedList.userId, context.userId), lte(savedList.createdAt, cutoff)))
          .orderBy(asc(savedList.id)),
        { portable: true },
      );
      return;
    case "saved-places":
      yield* emit(
        database
          .select({
            id: savedPlace.id,
            listId: savedPlace.listId,
            name: savedPlace.name,
            address: savedPlace.address,
            lat: savedPlace.lat,
            lng: savedPlace.lng,
            placeId: savedPlace.placeId,
            note: savedPlace.note,
            sortOrder: savedPlace.sortOrder,
            createdAt: savedPlace.createdAt,
          })
          .from(savedPlace)
          .innerJoin(savedList, eq(savedPlace.listId, savedList.id))
          .where(and(eq(savedList.userId, context.userId), lte(savedPlace.createdAt, cutoff)))
          .orderBy(asc(savedPlace.id)),
        { portable: true, map: (row) => ({ ...row, coordinates: [row.lng, row.lat] }) },
      );
      return;
    case "labeled-places":
      yield* emit(
        database
          .select({
            id: labeledPlace.id,
            label: labeledPlace.label,
            name: labeledPlace.name,
            address: labeledPlace.address,
            lat: labeledPlace.lat,
            lng: labeledPlace.lng,
            placeId: labeledPlace.placeId,
          })
          .from(labeledPlace)
          .where(eq(labeledPlace.userId, context.userId))
          .orderBy(asc(labeledPlace.id)),
        { portable: true, map: (row) => ({ ...row, coordinates: [row.lng, row.lat] }) },
      );
      return;
    case "personal-vehicles":
      yield* emit(
        database
          .select({
            id: personalVehicle.id,
            name: personalVehicle.name,
            kind: personalVehicle.kind,
            powertrain: personalVehicle.powertrain,
            isDefault: personalVehicle.isDefault,
            presetId: personalVehicle.presetId,
            ev: personalVehicle.ev,
            fuelConsumptionLPer100Km: personalVehicle.fuelConsumptionLPer100Km,
            createdAt: personalVehicle.createdAt,
            updatedAt: personalVehicle.updatedAt,
          })
          .from(personalVehicle)
          .where(
            and(eq(personalVehicle.userId, context.userId), lte(personalVehicle.createdAt, cutoff)),
          )
          .orderBy(asc(personalVehicle.id)),
        { portable: true },
      );
      return;
    case "parked-locations":
      yield* emit(
        database
          .select({
            id: parkedLocation.id,
            vehicleId: parkedLocation.vehicleId,
            lat: parkedLocation.lat,
            lng: parkedLocation.lng,
            address: parkedLocation.address,
            note: parkedLocation.note,
            expiresAt: parkedLocation.expiresAt,
            source: parkedLocation.source,
            accuracyMeters: parkedLocation.accuracyMeters,
            savedAt: parkedLocation.savedAt,
            updatedAt: parkedLocation.updatedAt,
          })
          .from(parkedLocation)
          .where(
            and(eq(parkedLocation.userId, context.userId), lte(parkedLocation.savedAt, cutoff)),
          )
          .orderBy(asc(parkedLocation.id)),
        {
          portable: true,
          policyCodes: ["shared-location-review"],
          map: (row) => ({ ...row, coordinates: [row.lng, row.lat] }),
        },
      );
      return;
    case "share-links":
      yield* emit(
        database
          .select({
            id: shareLink.id,
            targetType: shareLink.targetType,
            targetId: shareLink.targetId,
            mode: shareLink.mode,
            label: shareLink.label,
            snapshot: shareLink.snapshot,
            createdAt: shareLink.createdAt,
            updatedAt: shareLink.updatedAt,
            expiresAt: shareLink.expiresAt,
          })
          .from(shareLink)
          .where(and(eq(shareLink.userId, context.userId), lte(shareLink.createdAt, cutoff)))
          .orderBy(asc(shareLink.id)),
        {
          portable: true,
          policyCodes: ["share-token-redacted", "foreign-content-redacted"],
          map: ({ snapshot, targetId, ...row }) => ({
            ...row,
            targetIdDigest: pseudonymousIdentifier(targetId),
            snapshot: safeShareSnapshot(snapshot),
          }),
        },
      );
      return;
    case "timeline-connections":
      yield* emit(
        database
          .select({
            id: personalTimelineConnection.id,
            mode: personalTimelineConnection.mode,
            publicOrigin: personalTimelineConnection.publicOrigin,
            displayName: personalTimelineConnection.displayName,
            upstreamUserId: personalTimelineConnection.upstreamUserId,
            upstreamEmail: personalTimelineConnection.upstreamEmail,
            upstreamTimeZone: personalTimelineConnection.upstreamTimeZone,
            distanceUnit: personalTimelineConnection.distanceUnit,
            status: personalTimelineConnection.status,
            consecutiveFailures: personalTimelineConnection.consecutiveFailures,
            validatedAt: personalTimelineConnection.validatedAt,
            lastReadAt: personalTimelineConnection.lastReadAt,
            createdAt: personalTimelineConnection.createdAt,
            updatedAt: personalTimelineConnection.updatedAt,
          })
          .from(personalTimelineConnection)
          .where(
            and(
              eq(personalTimelineConnection.userId, context.userId),
              lte(personalTimelineConnection.createdAt, cutoff),
            ),
          )
          .orderBy(asc(personalTimelineConnection.id)),
        { portable: true, policyCodes: ["timeline-credential-redacted"] },
      );
      return;
    case "mangrove-keypairs":
      yield* emit(
        database
          .select({
            userId: mangroveKeypair.userId,
            encryptionMode: mangroveKeypair.encryptionMode,
            publicJwk: mangroveKeypair.publicJwk,
            createdAt: mangroveKeypair.createdAt,
          })
          .from(mangroveKeypair)
          .where(
            and(eq(mangroveKeypair.userId, context.userId), lte(mangroveKeypair.createdAt, cutoff)),
          )
          .orderBy(asc(mangroveKeypair.userId)),
        { policyCodes: ["public-key-only"] },
      );
      yield* emit(
        database
          .select({
            id: mangroveKeypairWrap.id,
            wrapType: mangroveKeypairWrap.wrapType,
            label: mangroveKeypairWrap.label,
            createdAt: mangroveKeypairWrap.createdAt,
          })
          .from(mangroveKeypairWrap)
          .where(
            and(
              eq(mangroveKeypairWrap.userId, context.userId),
              lte(mangroveKeypairWrap.createdAt, cutoff),
            ),
          )
          .orderBy(asc(mangroveKeypairWrap.id)),
        { policyCodes: ["public-key-only", "unlock-identity-redacted"] },
      );
      return;
    case "mobile-auth-handoffs":
      yield* emit(
        database
          .select({
            id: mobileAuthHandoff.id,
            purpose: mobileAuthHandoff.purpose,
            createdAt: mobileAuthHandoff.createdAt,
            expiresAt: mobileAuthHandoff.expiresAt,
            consumedAt: mobileAuthHandoff.consumedAt,
          })
          .from(mobileAuthHandoff)
          .where(
            and(
              eq(mobileAuthHandoff.userId, context.userId),
              lte(mobileAuthHandoff.createdAt, cutoff),
            ),
          )
          .orderBy(asc(mobileAuthHandoff.id)),
        { policyCodes: ["handoff-secret-redacted"] },
      );
      return;
    case "admin-audit-attribution":
      yield* emit(
        database
          .select({
            id: adminAuditLog.id,
            actorId: adminAuditLog.actorId,
            targetId: adminAuditLog.targetId,
            targetType: adminAuditLog.targetType,
            action: adminAuditLog.action,
            details: adminAuditLog.details,
            createdAt: adminAuditLog.createdAt,
          })
          .from(adminAuditLog)
          .where(
            and(
              or(
                eq(adminAuditLog.actorId, context.userId),
                and(
                  eq(adminAuditLog.targetId, context.userId),
                  inArray(adminAuditLog.targetType, ["user", "account"]),
                ),
              ),
              lte(adminAuditLog.createdAt, cutoff),
            ),
          )
          .orderBy(asc(adminAuditLog.id)),
        {
          policyCodes: ["rights-of-others", "foreign-identifiers-redacted"],
          map: (row) => ({
            recordId: pseudonymousIdentifier(row.id),
            actor: row.actorId === context.userId ? "subject" : "other-actor",
            target: row.targetId === context.userId ? "subject" : "other-target",
            targetType: row.targetType,
            action: row.action,
            details: safeAuditDetails(row.details),
            createdAt: row.createdAt,
          }),
        },
      );
      return;
    case "admin-jobs-attribution":
      yield* emit(
        database
          .select({
            id: adminJob.id,
            type: adminJob.type,
            status: adminJob.status,
            progress: adminJob.progress,
            createdAt: adminJob.createdAt,
            startedAt: adminJob.startedAt,
            finishedAt: adminJob.finishedAt,
          })
          .from(adminJob)
          .where(and(eq(adminJob.createdBy, context.userId), lte(adminJob.createdAt, cutoff)))
          .orderBy(asc(adminJob.id)),
        { policyCodes: ["job-payload-review"] },
      );
      return;
    case "installed-component-attribution":
      yield* emit(
        database
          .select({
            id: installedExtension.id,
            name: installedExtension.name,
            sourceTrust: installedExtension.sourceTrust,
            installedVersion: installedExtension.installedVersion,
            installedAt: installedExtension.installedAt,
            updatedAt: installedExtension.updatedAt,
          })
          .from(installedExtension)
          .where(
            and(
              eq(installedExtension.installedBy, context.userId),
              lte(installedExtension.installedAt, cutoff),
            ),
          )
          .orderBy(asc(installedExtension.id)),
        { policyCodes: ["attribution-safe-metadata"] },
      );
      yield* emit(
        database
          .select({
            id: installedIntegration.id,
            repository: installedIntegration.repository,
            installedVersion: installedIntegration.installedVersion,
            sourceType: installedIntegration.sourceType,
            installedAt: installedIntegration.installedAt,
            updatedAt: installedIntegration.updatedAt,
          })
          .from(installedIntegration)
          .where(
            and(
              eq(installedIntegration.installedBy, context.userId),
              lte(installedIntegration.installedAt, cutoff),
            ),
          )
          .orderBy(asc(installedIntegration.id)),
        { policyCodes: ["attribution-safe-metadata"] },
      );
      return;
    case "secret-update-attribution":
      yield* emit(
        database
          .select({
            id: integrationSecret.id,
            integrationId: integrationSecret.integrationId,
            key: integrationSecret.key,
            createdAt: integrationSecret.createdAt,
            updatedAt: integrationSecret.updatedAt,
            updatedBy: integrationSecret.updatedBy,
          })
          .from(integrationSecret)
          .where(
            and(
              eq(integrationSecret.updatedBy, context.userId),
              lte(integrationSecret.createdAt, cutoff),
            ),
          )
          .orderBy(asc(integrationSecret.id)),
        { policyCodes: ["secret-value-redacted"] },
      );
      yield* emit(
        database
          .select({
            id: serviceSecret.id,
            serviceId: serviceSecret.serviceId,
            key: serviceSecret.key,
            createdAt: serviceSecret.createdAt,
            updatedAt: serviceSecret.updatedAt,
            updatedBy: serviceSecret.updatedBy,
          })
          .from(serviceSecret)
          .where(
            and(eq(serviceSecret.updatedBy, context.userId), lte(serviceSecret.createdAt, cutoff)),
          )
          .orderBy(asc(serviceSecret.id)),
        { policyCodes: ["secret-value-redacted"] },
      );
      return;
    case "system-setting-attribution":
      yield* emit(
        database
          .select({
            key: systemSettings.key,
            updatedAt: systemSettings.updatedAt,
            updatedBy: systemSettings.updatedBy,
          })
          .from(systemSettings)
          .where(
            and(
              eq(systemSettings.updatedBy, context.userId),
              lte(systemSettings.updatedAt, cutoff),
            ),
          )
          .orderBy(asc(systemSettings.key)),
        { policyCodes: ["setting-value-redacted"] },
      );
      return;
    case "privacy-case-records": {
      const historicalOwnership = context.subjectLocatorDigests?.length
        ? inArray(dataSubjectRequest.locatorDigest, [...new Set(context.subjectLocatorDigests)])
        : undefined;
      const requestOwnership = context.requestId
        ? historicalOwnership
          ? or(
              eq(dataSubjectRequest.userId, context.userId),
              eq(dataSubjectRequest.id, context.requestId),
              historicalOwnership,
            )
          : or(
              eq(dataSubjectRequest.userId, context.userId),
              eq(dataSubjectRequest.id, context.requestId),
            )
        : historicalOwnership
          ? or(eq(dataSubjectRequest.userId, context.userId), historicalOwnership)
          : eq(dataSubjectRequest.userId, context.userId);
      yield* emit(
        database
          .select({
            id: dataSubjectRequest.id,
            kind: dataSubjectRequest.kind,
            channel: dataSubjectRequest.channel,
            state: dataSubjectRequest.state,
            receivedAt: dataSubjectRequest.receivedAt,
            registeredAt: dataSubjectRequest.registeredAt,
            dueAt: dataSubjectRequest.dueAt,
            identityState: dataSubjectRequest.identityState,
            deliveryState: dataSubjectRequest.deliveryState,
            completedAt: dataSubjectRequest.completedAt,
            closedAt: dataSubjectRequest.closedAt,
          })
          .from(dataSubjectRequest)
          .where(and(requestOwnership, lte(dataSubjectRequest.receivedAt, cutoff)))
          .orderBy(asc(dataSubjectRequest.id)),
        { policyCodes: ["protected-case-detail"] },
      );
      yield* emit(
        database
          .select({
            id: dataSubjectRequestNotification.id,
            requestId: dataSubjectRequestNotification.requestId,
            template: dataSubjectRequestNotification.template,
            channel: dataSubjectRequestNotification.channel,
            state: dataSubjectRequestNotification.state,
            attempts: dataSubjectRequestNotification.attempts,
            sentAt: dataSubjectRequestNotification.sentAt,
            createdAt: dataSubjectRequestNotification.createdAt,
          })
          .from(dataSubjectRequestNotification)
          .innerJoin(
            dataSubjectRequest,
            eq(dataSubjectRequestNotification.requestId, dataSubjectRequest.id),
          )
          .where(
            and(
              requestOwnership,
              lte(dataSubjectRequestNotification.createdAt, cutoff),
              lte(dataSubjectRequest.receivedAt, cutoff),
            ),
          )
          .orderBy(asc(dataSubjectRequestNotification.id)),
        { policyCodes: ["notification-content-redacted"] },
      );
      yield* emit(
        database
          .select({
            id: dataSubjectRequestEvent.id,
            requestId: dataSubjectRequestEvent.requestId,
            eventType: dataSubjectRequestEvent.eventType,
            actorKind: dataSubjectRequestEvent.actorKind,
            createdAt: dataSubjectRequestEvent.createdAt,
          })
          .from(dataSubjectRequestEvent)
          .innerJoin(
            dataSubjectRequest,
            eq(dataSubjectRequestEvent.requestId, dataSubjectRequest.id),
          )
          .where(
            and(
              requestOwnership,
              lte(dataSubjectRequestEvent.createdAt, cutoff),
              lte(dataSubjectRequest.receivedAt, cutoff),
            ),
          )
          .orderBy(asc(dataSubjectRequestEvent.id)),
        { policyCodes: ["protected-case-detail", "operator-identifiers-redacted"] },
      );
      yield* emit(
        database
          .select({
            id: dataSubjectRequestTask.id,
            requestId: dataSubjectRequestTask.requestId,
            registrationId: dataSubjectRequestTask.registrationId,
            status: dataSubjectRequestTask.status,
            required: dataSubjectRequestTask.required,
            recordCount: dataSubjectRequestTask.recordCount,
            exceptionCode: dataSubjectRequestTask.exceptionCode,
            redactionCode: dataSubjectRequestTask.redactionCode,
            collectedAt: dataSubjectRequestTask.collectedAt,
            createdAt: dataSubjectRequestTask.createdAt,
          })
          .from(dataSubjectRequestTask)
          .innerJoin(
            dataSubjectRequest,
            eq(dataSubjectRequestTask.requestId, dataSubjectRequest.id),
          )
          .where(
            and(
              requestOwnership,
              lte(dataSubjectRequestTask.createdAt, cutoff),
              lte(dataSubjectRequest.receivedAt, cutoff),
            ),
          )
          .orderBy(asc(dataSubjectRequestTask.id)),
        { policyCodes: ["protected-case-detail"] },
      );
      yield* emit(
        database
          .select({
            id: dataSubjectRequestIdentity.id,
            requestId: dataSubjectRequestIdentity.requestId,
            party: dataSubjectRequestIdentity.party,
            state: dataSubjectRequestIdentity.state,
            method: dataSubjectRequestIdentity.method,
            reasonableDoubtCode: dataSubjectRequestIdentity.reasonableDoubtCode,
            authorityState: dataSubjectRequestIdentity.authorityState,
            deliveryAuthorized: dataSubjectRequestIdentity.deliveryAuthorized,
            verifiedAt: dataSubjectRequestIdentity.verifiedAt,
            createdAt: dataSubjectRequestIdentity.createdAt,
            updatedAt: dataSubjectRequestIdentity.updatedAt,
          })
          .from(dataSubjectRequestIdentity)
          .innerJoin(
            dataSubjectRequest,
            eq(dataSubjectRequestIdentity.requestId, dataSubjectRequest.id),
          )
          .where(
            and(
              requestOwnership,
              lte(dataSubjectRequestIdentity.createdAt, cutoff),
              lte(dataSubjectRequest.receivedAt, cutoff),
            ),
          )
          .orderBy(asc(dataSubjectRequestIdentity.id)),
        {
          policyCodes: [
            "identity-evidence-redacted",
            "representative-contact-redacted",
            "operator-identifiers-redacted",
          ],
        },
      );
      yield* emit(
        database
          .select({
            id: dataSubjectRequestEmailChallenge.id,
            requestId: dataSubjectRequestEmailChallenge.requestId,
            identityId: dataSubjectRequestEmailChallenge.identityId,
            purpose: dataSubjectRequestEmailChallenge.purpose,
            party: dataSubjectRequestEmailChallenge.party,
            recipientSource: dataSubjectRequestEmailChallenge.recipientSource,
            state: dataSubjectRequestEmailChallenge.state,
            attempts: dataSubjectRequestEmailChallenge.attempts,
            maxAttempts: dataSubjectRequestEmailChallenge.maxAttempts,
            deliveryAttempts: dataSubjectRequestEmailChallenge.deliveryAttempts,
            maxDeliveryAttempts: dataSubjectRequestEmailChallenge.maxDeliveryAttempts,
            nextDeliveryAttemptAt: dataSubjectRequestEmailChallenge.nextDeliveryAttemptAt,
            lastDeliveryErrorCode: dataSubjectRequestEmailChallenge.lastDeliveryErrorCode,
            expiresAt: dataSubjectRequestEmailChallenge.expiresAt,
            issuedAt: dataSubjectRequestEmailChallenge.issuedAt,
            consumedAt: dataSubjectRequestEmailChallenge.consumedAt,
            revokedAt: dataSubjectRequestEmailChallenge.revokedAt,
            createdAt: dataSubjectRequestEmailChallenge.createdAt,
            updatedAt: dataSubjectRequestEmailChallenge.updatedAt,
          })
          .from(dataSubjectRequestEmailChallenge)
          .innerJoin(
            dataSubjectRequest,
            eq(dataSubjectRequestEmailChallenge.requestId, dataSubjectRequest.id),
          )
          .where(
            and(
              requestOwnership,
              lte(dataSubjectRequestEmailChallenge.createdAt, cutoff),
              lte(dataSubjectRequest.receivedAt, cutoff),
            ),
          )
          .orderBy(asc(dataSubjectRequestEmailChallenge.id)),
        { policyCodes: ["email-challenge-secrets-redacted"] },
      );
      yield* emit(
        database
          .select({
            id: dataExportReauthentication.id,
            requestId: dataExportReauthentication.requestId,
            channel: dataExportReauthentication.deliveryChannel,
            state: dataExportReauthentication.state,
            completedMethod: dataExportReauthentication.completedMethod,
            completedAt: dataExportReauthentication.completedAt,
            consumedAt: dataExportReauthentication.consumedAt,
            expiresAt: dataExportReauthentication.expiresAt,
            createdAt: dataExportReauthentication.createdAt,
          })
          .from(dataExportReauthentication)
          .innerJoin(
            dataSubjectRequest,
            eq(dataExportReauthentication.requestId, dataSubjectRequest.id),
          )
          .where(
            and(
              requestOwnership,
              lte(dataExportReauthentication.createdAt, cutoff),
              lte(dataSubjectRequest.receivedAt, cutoff),
            ),
          )
          .orderBy(asc(dataExportReauthentication.id)),
        {
          policyCodes: ["reauthentication-metadata", "session-identifiers-redacted"],
          map: ({ id, ...row }) => ({ ...row, challengeDigest: pseudonymousIdentifier(id) }),
        },
      );
      yield* emit(
        database
          .select({
            id: dataSubjectRequestBackupReview.id,
            requestId: dataSubjectRequestBackupReview.requestId,
            backupId: dataSubjectRequestBackupReview.backupId,
            createdAt: dataSubjectRequestBackupReview.createdAt,
            platformVersion: dataSubjectRequestBackupReview.platformVersion,
            decision: dataSubjectRequestBackupReview.decision,
            reasonCode: dataSubjectRequestBackupReview.reasonCode,
            reviewedAt: dataSubjectRequestBackupReview.reviewedAt,
          })
          .from(dataSubjectRequestBackupReview)
          .innerJoin(
            dataSubjectRequest,
            eq(dataSubjectRequestBackupReview.requestId, dataSubjectRequest.id),
          )
          .where(
            and(
              requestOwnership,
              lte(dataSubjectRequestBackupReview.createdAt, cutoff),
              lte(dataSubjectRequest.receivedAt, cutoff),
            ),
          )
          .orderBy(asc(dataSubjectRequestBackupReview.id)),
        {
          policyCodes: ["backup-review-metadata", "backup-identifiers-redacted"],
          map: ({ id: _id, backupId, ...row }) => ({
            ...row,
            backupReferenceDigest: pseudonymousIdentifier(backupId),
          }),
        },
      );
      return;
    }
    case "offline-package-ownership": {
      if (!context.offlinePrincipalKey || context.offlinePrincipalKey.byteLength < 32) return;
      const principal = deriveOfflinePackagePrincipal(context.userId, context.offlinePrincipalKey);
      yield* emit(
        database
          .select({
            packageId: dataManagerOfflinePackageArtifactReferences.packageId,
            byteLength: dataManagerOfflinePackageArtifactReferences.byteLength,
            retainedAt: dataManagerOfflinePackageArtifactReferences.retainedAt,
          })
          .from(dataManagerOfflinePackageArtifactReferences)
          .where(
            and(
              eq(dataManagerOfflinePackageArtifactReferences.principal, principal),
              lte(dataManagerOfflinePackageArtifactReferences.retainedAt, cutoff),
            ),
          )
          .orderBy(asc(dataManagerOfflinePackageArtifactReferences.packageId)),
        { policyCodes: ["offline-safe-metadata"] },
      );
      yield* emit(
        database
          .select({
            jobId: dataManagerOfflinePackageJobOwners.jobId,
            packageId: dataManagerOfflinePackageJobs.packageId,
            status: dataManagerOfflinePackageJobs.status,
            createdAt: dataManagerOfflinePackageJobOwners.createdAt,
            updatedAt: dataManagerOfflinePackageJobs.updatedAt,
          })
          .from(dataManagerOfflinePackageJobOwners)
          .innerJoin(
            dataManagerOfflinePackageJobs,
            eq(dataManagerOfflinePackageJobOwners.jobId, dataManagerOfflinePackageJobs.id),
          )
          .where(
            and(
              eq(dataManagerOfflinePackageJobOwners.principal, principal),
              lte(dataManagerOfflinePackageJobOwners.createdAt, cutoff),
              lte(dataManagerOfflinePackageJobs.createdAt, cutoff),
            ),
          )
          .orderBy(asc(dataManagerOfflinePackageJobOwners.jobId)),
        { policyCodes: ["offline-safe-metadata"] },
      );
      return;
    }
    case "disclosure-events":
      yield* emit(
        database
          .select({
            id: dataDisclosureEvent.id,
            occurredAt: dataDisclosureEvent.occurredAt,
            recipientId: dataDisclosureEvent.recipientId,
            recipientName: dataDisclosureEvent.recipientName,
            recipientRole: dataDisclosureEvent.recipientRole,
            recipientCountry: dataDisclosureEvent.recipientCountry,
            recipientPrivacyUrl: dataDisclosureEvent.recipientPrivacyUrl,
            integrationId: dataDisclosureEvent.integrationId,
            operationCode: dataDisclosureEvent.operationCode,
            categoryCode: dataDisclosureEvent.categoryCode,
            purposeCode: dataDisclosureEvent.purposeCode,
            legalBasisCode: dataDisclosureEvent.legalBasisCode,
            transferSafeguardCode: dataDisclosureEvent.transferSafeguardCode,
            externalReferenceDigest: dataDisclosureEvent.externalReferenceDigest,
          })
          .from(dataDisclosureEvent)
          .where(
            and(
              eq(dataDisclosureEvent.userId, context.userId),
              lte(dataDisclosureEvent.occurredAt, cutoff),
            ),
          )
          .orderBy(asc(dataDisclosureEvent.id)),
      );
      return;
    default:
      return;
  }
}

/** Bounded materialization helper for focused projection tests. Live snapshot
 * collection always uses collectOpenMapxDataSnapshot and encrypted streams. */
export async function collectOpenMapxRegistration(
  registrationId: string,
  context: OpenMapxCollectorContext,
): Promise<CollectorSourcePart> {
  const registration = getSubjectDataRegistration(registrationId);
  if (!registration) throw new Error("Unknown privacy registration");
  if (registration.strategy === "not_personal")
    return {
      registrationId,
      category: registration.category,
      records: [],
      outcome: "not_applicable",
      warningCodes: [],
      capturedAt: new Date().toISOString(),
    };
  if (registration.strategy === "operator_task")
    return {
      registrationId,
      category: registration.category,
      records: [],
      outcome: "omitted_with_reason",
      warningCodes: ["operator-review-required"],
      capturedAt: new Date().toISOString(),
    };
  const streamedRecords: ReturnType<typeof projectSubjectRecord>[] = [];
  for await (const record of streamOpenMapxRegistrationRecords(registrationId, context)) {
    if (streamedRecords.length >= TEST_MATERIALIZATION_RECORD_LIMIT)
      throw new Error("test collector materialization limit exceeded");
    streamedRecords.push(record);
  }
  return includedPart(registrationId, registration.category, streamedRecords);
}

const PRIMARY_ARTICLE_TARGETS: Readonly<Record<string, string>> = {
  "account-profile": "account",
  "auth-accounts": "authentication",
  "auth-sessions": "authentication",
  "auth-passkeys": "authentication",
  "auth-two-factor": "authentication",
  "auth-verifications": "authentication",
  "auth-oauth-resources": "authentication",
  "mobile-auth-handoffs": "authentication",
  "saved-lists": "saved-content",
  "saved-places": "saved-content",
  "labeled-places": "saved-content",
  "personal-vehicles": "vehicles",
  "parked-locations": "vehicles",
  "share-links": "sharing",
  "timeline-connections": "timeline-connections",
  "admin-audit-attribution": "activity",
  "disclosure-events": "disclosures",
  "privacy-case-records": "requests",
};

const PRIMARY_PORTABLE_TARGETS: Readonly<Record<string, string>> = {
  "account-profile": "profile",
  "saved-lists": "portable-lists",
  "saved-places": "portable-places",
  "labeled-places": "portable-places",
  "personal-vehicles": "portable-vehicles",
  "parked-locations": "portable-parking",
  "share-links": "preferences",
  "timeline-connections": "preferences",
};

function articleStreamRecord(
  registrationId: string,
  record: ReturnType<typeof projectSubjectRecord>,
): Record<string, unknown> {
  const { id: sourceId, ...data } = record.data;
  return {
    ...data,
    ...(sourceId === undefined ? {} : { sourceId }),
    id: record.id,
    registrationId,
    policyCodes: record.policyCodes ?? [],
  };
}

function portableStreamRecord(
  record: ReturnType<typeof projectSubjectRecord>,
): Record<string, unknown> {
  return { id: record.id, ...record.data };
}

async function collectOpenMapxStreams(
  context: OpenMapxCollectorContext,
  snapshotAt: Date,
): Promise<{
  parts: CollectorSourcePart[];
  entries: CollectorSourcePartEntry[];
  disposeSources?: () => Promise<void>;
}> {
  const primaryRegistrations = SUBJECT_DATA_CATALOGUE.filter(
    (registration) =>
      registration.source === "openmapx-db" && registration.strategy === "collector",
  );
  const primaryIds = new Set(primaryRegistrations.map((registration) => registration.id));
  const receiptRegistrations = [...(context.receiptSnapshotOverrides?.keys() ?? [])]
    .filter((id) => !primaryIds.has(id))
    .map((id) => getSubjectDataRegistration(id))
    .filter((registration): registration is NonNullable<typeof registration> =>
      Boolean(registration),
    );
  const registrations = [...primaryRegistrations, ...receiptRegistrations];
  const spool = await EncryptedSourceSpool.create(context.streamingLimits);
  const counts = new Map<string, number>();
  const entries: NonNullable<CollectorSourcePart["entries"]> = [];
  try {
    const articleTargets = [
      "account",
      "authentication",
      "saved-content",
      "vehicles",
      "sharing",
      "timeline-connections",
      "activity",
      "disclosures",
      "requests",
      "other",
    ] as const;
    for (const target of articleTargets) {
      const targetRegistrations = registrations.filter(
        ({ id }) =>
          !context.excludedRegistrationIds?.has(id) &&
          (PRIMARY_ARTICLE_TARGETS[id] ?? "other") === target,
      );
      const records = (async function* () {
        for (const registration of targetRegistrations) {
          for await (const record of streamOpenMapxRegistrationRecords(registration.id, context)) {
            counts.set(registration.id, (counts.get(registration.id) ?? 0) + 1);
            yield articleStreamRecord(registration.id, record);
          }
        }
      })();
      const encoded =
        target === "account" || target === "authentication"
          ? encodeJsonArray(records, context.streamingLimits)
          : encodeJsonLines(records, context.streamingLimits);
      const entry = await spool.write({
        logicalId: target,
        content: encoded.source,
        mediaType:
          target === "account" || target === "authentication"
            ? "application/json"
            : "application/jsonl",
        schemaId: "article-15-record-v1",
      });
      const facts = await encoded.facts;
      if (facts.records === 0) continue;
      if (entry.bytes !== facts.bytes || entry.sha256 !== facts.sha256)
        throw new Error("primary source spool facts mismatch");
      entry.recordCount = facts.records;
      entries.push(entry);
    }

    const portableTargets = [
      "profile",
      "portable-lists",
      "portable-places",
      "portable-vehicles",
      "portable-parking",
      "preferences",
    ] as const;
    for (const target of portableTargets) {
      const targetRegistrations = registrations.filter(
        ({ id }) =>
          !context.excludedRegistrationIds?.has(id) && PRIMARY_PORTABLE_TARGETS[id] === target,
      );
      if (targetRegistrations.length === 0) continue;
      const records = (async function* () {
        for (const registration of targetRegistrations) {
          for await (const record of streamOpenMapxRegistrationRecords(registration.id, context)) {
            if (record.portable) yield portableStreamRecord(record);
          }
        }
      })();
      const encoded =
        target === "portable-places" || target === "portable-parking"
          ? encodeGeoJson(records, context.streamingLimits)
          : encodeJsonArray(records, context.streamingLimits);
      const entry = await spool.write({
        logicalId: target,
        content: encoded.source,
        mediaType:
          target === "portable-places" || target === "portable-parking"
            ? "application/geo+json"
            : "application/json",
        schemaId: "article-20-v1",
      });
      const facts = await encoded.facts;
      if (facts.records === 0) continue;
      if (entry.bytes !== facts.bytes || entry.sha256 !== facts.sha256)
        throw new Error("primary portable spool facts mismatch");
      entry.recordCount = facts.records;
      entries.push(entry);
    }

    const parts: CollectorSourcePart[] = registrations.map((registration) => {
      const recordCount = counts.get(registration.id) ?? 0;
      const offlineUnavailable =
        registration.id === "offline-package-ownership" &&
        (!context.offlinePrincipalKey || context.offlinePrincipalKey.byteLength < 32);
      const receiptRedis =
        registration.id === "redis-subject-controls" &&
        context.receiptSnapshotOverrides?.has(registration.id);
      return {
        registrationId: registration.id,
        category: registration.category,
        records: [],
        recordCount,
        outcome: offlineUnavailable
          ? ("unavailable" as const)
          : recordCount > 0
            ? ("included" as const)
            : ("reviewed_no_match" as const),
        warningCodes: offlineUnavailable
          ? ["offline-principal-key-unavailable"]
          : receiptRedis
            ? ["redis-exact-locator-only"]
            : [],
        capturedAt:
          context.receiptSnapshotCapturedAt?.get(registration.id)?.toISOString() ??
          snapshotAt.toISOString(),
      };
    });
    if (entries.length === 0) {
      await spool.dispose();
      return { parts, entries };
    }
    return { parts, entries, disposeSources: () => spool.dispose() };
  } catch (error) {
    await spool.dispose();
    throw error;
  }
}

/**
 * Collect every OpenMapX registration from one coherent, read-only snapshot.
 * The callback is kept separate from the collector so non-Postgres fixtures
 * can still exercise ownership projections without pretending to provide a
 * distributed transaction with Dawarich/Redis.
 */
export async function collectOpenMapxDataSnapshot(context: OpenMapxCollectorContext): Promise<{
  snapshotAt: Date;
  parts: CollectorSourcePart[];
  entries: CollectorSourcePartEntry[];
  disposeSources?: () => Promise<void>;
}> {
  const database = dbOf(context) as typeof defaultDb & { transaction?: unknown };
  if (typeof database.transaction !== "function")
    throw new Error("primary OpenMapX snapshot requires database transactions");
  return database.transaction(
    async (tx) => {
      const snapshotAt = context.snapshotAt ?? new Date();
      const collected = await collectOpenMapxStreams(
        {
          ...context,
          database: tx as unknown as typeof defaultDb,
          snapshotAt,
        },
        snapshotAt,
      );
      return { snapshotAt, ...collected };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  ) as Promise<{
    snapshotAt: Date;
    parts: CollectorSourcePart[];
    entries: CollectorSourcePartEntry[];
    disposeSources?: () => Promise<void>;
  }>;
}
