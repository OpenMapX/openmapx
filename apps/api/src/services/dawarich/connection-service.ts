import { randomUUID } from "node:crypto";
import type {
  ConnectPersonalTimelineRequest,
  PersonalTimelineErrorCode,
  TimelineConnectionMode,
  TimelineConnectionStatus,
  TimelineConnectionView,
} from "@openmapx/core";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  type PersonalTimelineConnectionRow,
  personalTimelineConnection,
} from "../../db/timeline-connection-schema.js";
import { type AuditLogEntry, writeAuditLog } from "../../utils/audit-log.js";
import {
  type PersonalTimelineRequestLabels,
  recordPersonalTimelineRequest,
} from "../metrics/index.js";
import { decrypt, encrypt } from "../secrets.js";
import { DawarichClient, DawarichClientError, type DawarichClientOptions } from "./client.js";
import {
  type ManagedDawarichResolver,
  type ManagedDawarichState,
  managedDawarichResolver,
} from "./managed-resolver.js";
import { timelinePrivateHostAllowlist } from "./private-hosts.js";

export type { ManagedDawarichResolver, ManagedDawarichState } from "./managed-resolver.js";

export type TimelineConnectionErrorCode = PersonalTimelineErrorCode;

export class TimelineConnectionError extends Error {
  constructor(
    readonly code: TimelineConnectionErrorCode,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(code);
    this.name = "TimelineConnectionError";
  }
}

export interface TimelineConnectionStore {
  findByUserId(userId: string): Promise<PersonalTimelineConnectionRow | null>;
  replaceForUser(row: PersonalTimelineConnectionRow): Promise<PersonalTimelineConnectionRow>;
  updateForUser(
    userId: string,
    updates: Partial<PersonalTimelineConnectionRow>,
    expectedEncryptedApiKey?: string,
  ): Promise<PersonalTimelineConnectionRow | null>;
  recordFailureForUser(
    userId: string,
    expectedEncryptedApiKey: string,
    failureKind: "credential_invalid" | "transient",
    updatedAt: Date,
  ): Promise<PersonalTimelineConnectionRow | null>;
  recordFailureForSnapshot(
    userId: string,
    snapshot: TimelineConnectionSnapshot,
    failureKind: "credential_invalid" | "transient",
    updatedAt: Date,
  ): Promise<PersonalTimelineConnectionRow | null>;
  updateForSnapshot(
    userId: string,
    snapshot: TimelineConnectionSnapshot,
    updates: Partial<PersonalTimelineConnectionRow>,
  ): Promise<PersonalTimelineConnectionRow | null>;
  deleteForUser(userId: string): Promise<void>;
}

export interface TimelineConnectionSnapshot {
  id: string;
  /** Opaque encrypted credential generation. Never serialize or log this value. */
  credentialGeneration: string;
}

export class DrizzleTimelineConnectionStore implements TimelineConnectionStore {
  async findByUserId(userId: string): Promise<PersonalTimelineConnectionRow | null> {
    const [row] = await db
      .select()
      .from(personalTimelineConnection)
      .where(eq(personalTimelineConnection.userId, userId))
      .limit(1);
    return row ?? null;
  }

  async replaceForUser(row: PersonalTimelineConnectionRow): Promise<PersonalTimelineConnectionRow> {
    return db.transaction(async (tx) => {
      const [saved] = await tx
        .insert(personalTimelineConnection)
        .values(row)
        .onConflictDoUpdate({
          target: personalTimelineConnection.userId,
          set: {
            mode: row.mode,
            publicOrigin: row.publicOrigin,
            displayName: row.displayName,
            encryptedApiKey: row.encryptedApiKey,
            encryptionIv: row.encryptionIv,
            encryptionTag: row.encryptionTag,
            upstreamUserId: row.upstreamUserId,
            upstreamEmail: row.upstreamEmail,
            upstreamTimeZone: row.upstreamTimeZone,
            distanceUnit: row.distanceUnit,
            status: row.status,
            consecutiveFailures: row.consecutiveFailures,
            validatedAt: row.validatedAt,
            lastReadAt: row.lastReadAt,
            updatedAt: row.updatedAt,
          },
        })
        .returning();
      if (!saved) throw new Error("Timeline connection upsert returned no row");
      return saved;
    });
  }

  async updateForUser(
    userId: string,
    updates: Partial<PersonalTimelineConnectionRow>,
    expectedEncryptedApiKey?: string,
  ): Promise<PersonalTimelineConnectionRow | null> {
    const [row] = await db
      .update(personalTimelineConnection)
      .set(updates)
      .where(
        expectedEncryptedApiKey
          ? and(
              eq(personalTimelineConnection.userId, userId),
              eq(personalTimelineConnection.encryptedApiKey, expectedEncryptedApiKey),
            )
          : eq(personalTimelineConnection.userId, userId),
      )
      .returning();
    return row ?? null;
  }

  async recordFailureForUser(
    userId: string,
    expectedEncryptedApiKey: string,
    failureKind: "credential_invalid" | "transient",
    updatedAt: Date,
  ): Promise<PersonalTimelineConnectionRow | null> {
    const nextFailureCount = sql<number>`${personalTimelineConnection.consecutiveFailures} + 1`;
    const nextStatus =
      failureKind === "credential_invalid"
        ? "invalid"
        : sql<TimelineConnectionStatus>`CASE
            WHEN ${personalTimelineConnection.status} = 'invalid' THEN 'invalid'
            WHEN ${nextFailureCount} >= 3 THEN 'degraded'
            ELSE 'connected'
          END`;
    const [row] = await db
      .update(personalTimelineConnection)
      .set({
        consecutiveFailures: nextFailureCount,
        status: nextStatus,
        updatedAt,
      })
      .where(
        and(
          eq(personalTimelineConnection.userId, userId),
          eq(personalTimelineConnection.encryptedApiKey, expectedEncryptedApiKey),
        ),
      )
      .returning();
    return row ?? null;
  }

  async updateForSnapshot(
    userId: string,
    snapshot: TimelineConnectionSnapshot,
    updates: Partial<PersonalTimelineConnectionRow>,
  ): Promise<PersonalTimelineConnectionRow | null> {
    const [row] = await db
      .update(personalTimelineConnection)
      .set(updates)
      .where(
        and(
          eq(personalTimelineConnection.userId, userId),
          eq(personalTimelineConnection.id, snapshot.id),
          eq(personalTimelineConnection.encryptedApiKey, snapshot.credentialGeneration),
        ),
      )
      .returning();
    return row ?? null;
  }

  async recordFailureForSnapshot(
    userId: string,
    snapshot: TimelineConnectionSnapshot,
    failureKind: "credential_invalid" | "transient",
    updatedAt: Date,
  ): Promise<PersonalTimelineConnectionRow | null> {
    const nextFailureCount = sql<number>`${personalTimelineConnection.consecutiveFailures} + 1`;
    const nextStatus =
      failureKind === "credential_invalid"
        ? "invalid"
        : sql<TimelineConnectionStatus>`CASE
            WHEN ${personalTimelineConnection.status} = 'invalid' THEN 'invalid'
            WHEN ${nextFailureCount} >= 3 THEN 'degraded'
            ELSE 'connected'
          END`;
    const [row] = await db
      .update(personalTimelineConnection)
      .set({ consecutiveFailures: nextFailureCount, status: nextStatus, updatedAt })
      .where(
        and(
          eq(personalTimelineConnection.userId, userId),
          eq(personalTimelineConnection.id, snapshot.id),
          eq(personalTimelineConnection.encryptedApiKey, snapshot.credentialGeneration),
        ),
      )
      .returning();
    return row ?? null;
  }

  async deleteForUser(userId: string): Promise<void> {
    await db
      .delete(personalTimelineConnection)
      .where(eq(personalTimelineConnection.userId, userId));
  }
}

type ValidationClient = Pick<DawarichClient, "getCurrentUser" | "getSettings" | "getTimeline">;
type ClientFactory = (options: DawarichClientOptions) => ValidationClient;
type AuditWriter = (entry: AuditLogEntry) => Promise<void>;

export interface TimelineConnectionServiceOptions {
  store?: TimelineConnectionStore;
  managedResolver?: ManagedDawarichResolver;
  clientFactory?: ClientFactory;
  privateHosts?: string[];
  audit?: AuditWriter;
  now?: () => Date;
  id?: () => string;
  metricNow?: () => number;
  recordMetric?: (labels: PersonalTimelineRequestLabels, latencyMs: number) => void;
}

interface ResolvedCandidate {
  mode: TimelineConnectionMode;
  upstreamBaseUrl: string;
  publicOrigin: string;
  displayName: string;
  hostname: string;
  allowPrivateHosts: string[];
  apiKey: string;
}

interface LifecycleAuditContext {
  mode: TimelineConnectionMode | null;
  hostname: string | null;
}

interface ValidatedMetadata {
  upstreamUserId: string | null;
  upstreamEmail: string | null;
  upstreamTimeZone: string;
  distanceUnit: string | null;
}

export interface DecryptedTimelineConnection {
  mode: TimelineConnectionMode;
  publicOrigin: string;
  upstreamBaseUrl: string;
  hostname: string;
  apiKey: string;
  timeZone: string;
  distanceUnit: string | null;
  allowPrivateHosts: string[];
  connectionSnapshot: TimelineConnectionSnapshot;
}

function strictOrigin(value: string, protocol: "https:" | "http-or-https"): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TimelineConnectionError("TIMELINE_INSTANCE_UNSUPPORTED");
  }
  if (
    (protocol === "https:"
      ? parsed.protocol !== "https:"
      : !["http:", "https:"].includes(parsed.protocol)) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TimelineConnectionError("TIMELINE_INSTANCE_UNSUPPORTED");
  }
  return new URL(parsed.origin);
}

function asConnectionError(error: unknown): TimelineConnectionError {
  if (error instanceof TimelineConnectionError) return error;
  if (!(error instanceof DawarichClientError)) {
    return new TimelineConnectionError("TIMELINE_UPSTREAM_UNAVAILABLE");
  }
  switch (error.kind) {
    case "unauthorized":
    case "forbidden":
      return new TimelineConnectionError("TIMELINE_CREDENTIAL_INVALID");
    case "rate_limited":
      return new TimelineConnectionError("TIMELINE_RATE_LIMITED", error.retryAfterSeconds);
    case "unavailable":
      return new TimelineConnectionError("TIMELINE_UPSTREAM_UNAVAILABLE");
    case "unsupported":
      return new TimelineConnectionError("TIMELINE_INSTANCE_UNSUPPORTED");
    case "invalid_response":
      return new TimelineConnectionError("TIMELINE_RESPONSE_INVALID");
    case "page_limit":
      return new TimelineConnectionError("TIMELINE_RESPONSE_INVALID");
  }
}

export function metricOutcome(
  error: unknown,
): Exclude<PersonalTimelineRequestLabels["outcome"], "ok" | "partial"> {
  const safe = asConnectionError(error);
  switch (safe.code) {
    case "TIMELINE_NOT_CONNECTED":
      return "not_connected";
    case "TIMELINE_CREDENTIAL_INVALID":
      return "invalid_credential";
    case "TIMELINE_RATE_LIMITED":
      return "rate_limited";
    case "TIMELINE_MANAGED_DISABLED":
    case "TIMELINE_UPSTREAM_UNAVAILABLE":
      return "unavailable";
    case "TIMELINE_INSTANCE_UNSUPPORTED":
    case "TIMELINE_PLAN_RESTRICTED":
    case "TIMELINE_RESPONSE_INVALID":
      return "invalid_response";
  }
}

function connectionView(row: PersonalTimelineConnectionRow): TimelineConnectionView["connection"] {
  return {
    mode: row.mode,
    publicOrigin: row.publicOrigin,
    displayName: row.displayName,
    upstreamEmail: row.upstreamEmail,
    timeZone: row.upstreamTimeZone,
    distanceUnit: row.distanceUnit,
    status: row.status,
    validatedAt: row.validatedAt.toISOString(),
    lastReadAt: row.lastReadAt?.toISOString() ?? null,
  };
}

export class TimelineConnectionService {
  private readonly store: TimelineConnectionStore;
  private readonly managedResolver: ManagedDawarichResolver;
  private readonly clientFactory: ClientFactory;
  private readonly privateHosts: string[];
  private readonly audit: AuditWriter;
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly metricNow: () => number;
  private readonly recordMetric: (labels: PersonalTimelineRequestLabels, latencyMs: number) => void;

  constructor(options: TimelineConnectionServiceOptions = {}) {
    this.store = options.store ?? new DrizzleTimelineConnectionStore();
    this.managedResolver = options.managedResolver ?? managedDawarichResolver;
    this.clientFactory =
      options.clientFactory ?? ((clientOptions) => new DawarichClient(clientOptions));
    this.privateHosts = options.privateHosts ?? timelinePrivateHostAllowlist();
    this.audit = options.audit ?? writeAuditLog;
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.metricNow = options.metricNow ?? (() => performance.now());
    this.recordMetric = options.recordMetric ?? recordPersonalTimelineRequest;
  }

  async connect(
    userId: string,
    request: ConnectPersonalTimelineRequest,
  ): Promise<TimelineConnectionView> {
    const startedAt = this.metricNow();
    try {
      const result = await this.connectUnmetered(userId, request);
      this.recordMetric(
        { mode: request.mode, operation: "connect", outcome: "ok" },
        this.metricNow() - startedAt,
      );
      return result;
    } catch (error) {
      this.recordMetric(
        { mode: request.mode, operation: "connect", outcome: metricOutcome(error) },
        this.metricNow() - startedAt,
      );
      throw error;
    }
  }

  private async connectUnmetered(
    userId: string,
    request: ConnectPersonalTimelineRequest,
  ): Promise<TimelineConnectionView> {
    const previous = await this.store.findByUserId(userId);
    const action = previous ? "timeline.switch" : "timeline.connect";
    let candidate: ResolvedCandidate | null = null;
    let auditContext: LifecycleAuditContext = { mode: request.mode, hostname: null };
    try {
      candidate = await this.resolveCandidate(request);
      auditContext = candidate;
      const metadata = await this.validate(candidate);
      const encrypted = encrypt(candidate.apiKey);
      const now = this.now();
      await this.store.replaceForUser({
        id: previous?.id ?? this.id(),
        userId,
        mode: candidate.mode,
        publicOrigin: candidate.publicOrigin,
        displayName: candidate.displayName,
        encryptedApiKey: encrypted.ciphertext,
        encryptionIv: encrypted.iv,
        encryptionTag: encrypted.tag,
        upstreamUserId: metadata.upstreamUserId,
        upstreamEmail: metadata.upstreamEmail,
        upstreamTimeZone: metadata.upstreamTimeZone,
        distanceUnit: metadata.distanceUnit,
        status: "connected",
        consecutiveFailures: 0,
        validatedAt: now,
        lastReadAt: null,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      });
      await this.writeLifecycleAudit(userId, action, auditContext, "success");
      return this.getConnectionView(userId);
    } catch (error) {
      const safeError = asConnectionError(error);
      await this.writeLifecycleAudit(userId, action, auditContext, "failure");
      throw safeError;
    }
  }

  async getConnectionView(userId: string): Promise<TimelineConnectionView> {
    const [row, managed] = await Promise.all([
      this.store.findByUserId(userId),
      this.resolveManagedView(),
    ]);
    return { connected: row !== null, connection: row ? connectionView(row) : null, managed };
  }

  async testConnection(userId: string): Promise<TimelineConnectionView> {
    const startedAt = this.metricNow();
    let mode: TimelineConnectionMode = "external";
    try {
      const result = await this.testConnectionUnmetered(userId, (resolvedMode) => {
        mode = resolvedMode;
      });
      this.recordMetric({ mode, operation: "test", outcome: "ok" }, this.metricNow() - startedAt);
      return result;
    } catch (error) {
      this.recordMetric(
        { mode, operation: "test", outcome: metricOutcome(error) },
        this.metricNow() - startedAt,
      );
      throw error;
    }
  }

  private async testConnectionUnmetered(
    userId: string,
    captureMode: (mode: TimelineConnectionMode) => void,
  ): Promise<TimelineConnectionView> {
    const row = await this.store.findByUserId(userId);
    if (!row) throw new TimelineConnectionError("TIMELINE_NOT_CONNECTED");
    captureMode(row.mode);
    const hostname = strictOrigin(row.publicOrigin, "https:").hostname;
    const auditCandidate: ResolvedCandidate = {
      mode: row.mode,
      upstreamBaseUrl: row.publicOrigin,
      publicOrigin: row.publicOrigin,
      displayName: row.displayName,
      hostname,
      allowPrivateHosts: [],
      apiKey: "",
    };
    try {
      const credential = await this.decryptConnectionCredential(userId);
      const metadata = await this.validate({
        ...auditCandidate,
        upstreamBaseUrl: credential.upstreamBaseUrl,
        allowPrivateHosts: credential.allowPrivateHosts,
        apiKey: credential.apiKey,
      });
      const now = this.now();
      await this.store.updateForUser(
        userId,
        {
          upstreamUserId: metadata.upstreamUserId,
          upstreamEmail: metadata.upstreamEmail,
          upstreamTimeZone: metadata.upstreamTimeZone,
          distanceUnit: metadata.distanceUnit,
          status: "connected",
          consecutiveFailures: 0,
          validatedAt: now,
          updatedAt: now,
        },
        row.encryptedApiKey,
      );
      await this.writeLifecycleAudit(userId, "timeline.test", auditCandidate, "success");
      return this.getConnectionView(userId);
    } catch (error) {
      const safeError = asConnectionError(error);
      if (safeError.code !== "TIMELINE_MANAGED_DISABLED") {
        await this.store.recordFailureForUser(
          userId,
          row.encryptedApiKey,
          safeError.code === "TIMELINE_CREDENTIAL_INVALID" ? "credential_invalid" : "transient",
          this.now(),
        );
      }
      await this.writeLifecycleAudit(userId, "timeline.test", auditCandidate, "failure");
      throw safeError;
    }
  }

  async decryptConnectionCredential(userId: string): Promise<DecryptedTimelineConnection> {
    const row = await this.store.findByUserId(userId);
    if (!row) throw new TimelineConnectionError("TIMELINE_NOT_CONNECTED");
    let upstreamBaseUrl = row.publicOrigin;
    let allowPrivateHosts = this.privateHosts;
    if (row.mode === "managed") {
      const managed = await this.resolveHealthyManaged();
      upstreamBaseUrl = managed.internalBaseUrl;
      try {
        allowPrivateHosts = [strictOrigin(upstreamBaseUrl, "http-or-https").hostname];
      } catch {
        throw new TimelineConnectionError("TIMELINE_MANAGED_DISABLED");
      }
    }
    return {
      mode: row.mode,
      publicOrigin: row.publicOrigin,
      upstreamBaseUrl,
      hostname: strictOrigin(row.publicOrigin, "https:").hostname,
      apiKey: decrypt(row.encryptedApiKey, row.encryptionIv, row.encryptionTag),
      timeZone: row.upstreamTimeZone,
      distanceUnit: row.distanceUnit,
      allowPrivateHosts,
      connectionSnapshot: { id: row.id, credentialGeneration: row.encryptedApiKey },
    };
  }

  async recordReadSuccess(userId: string, snapshot: TimelineConnectionSnapshot): Promise<boolean> {
    const now = this.now();
    const row = await this.store.updateForSnapshot(userId, snapshot, {
      lastReadAt: now,
      status: "connected",
      consecutiveFailures: 0,
      updatedAt: now,
    });
    return row !== null;
  }

  async updateReadMetadata(
    userId: string,
    snapshot: TimelineConnectionSnapshot,
    metadata: { timeZone: string; distanceUnit: string | null },
  ): Promise<TimelineConnectionSnapshot | null> {
    const now = this.now();
    const row = await this.store.updateForSnapshot(userId, snapshot, {
      upstreamTimeZone: metadata.timeZone,
      distanceUnit: metadata.distanceUnit,
      updatedAt: now,
    });
    return row ? { id: row.id, credentialGeneration: row.encryptedApiKey } : null;
  }

  async recordReadFailure(
    userId: string,
    snapshot: TimelineConnectionSnapshot,
    failureKind: "credential_invalid" | "transient",
  ): Promise<void> {
    await this.store.recordFailureForSnapshot(userId, snapshot, failureKind, this.now());
  }

  async deleteConnection(userId: string): Promise<void> {
    const row = await this.store.findByUserId(userId);
    await this.store.deleteForUser(userId);
    const candidate = row
      ? {
          mode: row.mode,
          upstreamBaseUrl: row.publicOrigin,
          publicOrigin: row.publicOrigin,
          displayName: row.displayName,
          hostname: strictOrigin(row.publicOrigin, "https:").hostname,
          allowPrivateHosts: [],
          apiKey: "",
        }
      : null;
    await this.writeLifecycleAudit(userId, "timeline.disconnect", candidate, "success");
  }

  private async resolveCandidate(
    request: ConnectPersonalTimelineRequest,
  ): Promise<ResolvedCandidate> {
    if (request.mode === "external") {
      const origin = strictOrigin(request.instanceUrl, "https:");
      return {
        mode: "external",
        upstreamBaseUrl: origin.origin,
        publicOrigin: origin.origin,
        displayName: request.displayName?.trim() || origin.host,
        hostname: origin.hostname,
        allowPrivateHosts: this.privateHosts,
        apiKey: request.apiKey,
      };
    }
    if (request.mode !== "managed" || "instanceUrl" in request) {
      throw new TimelineConnectionError("TIMELINE_INSTANCE_UNSUPPORTED");
    }
    const managed = await this.resolveHealthyManaged();
    let internal: URL;
    let publicOrigin: URL;
    try {
      internal = strictOrigin(managed.internalBaseUrl, "http-or-https");
      publicOrigin = strictOrigin(managed.publicOrigin, "https:");
    } catch {
      throw new TimelineConnectionError("TIMELINE_MANAGED_DISABLED");
    }
    return {
      mode: "managed",
      upstreamBaseUrl: internal.origin,
      publicOrigin: publicOrigin.origin,
      displayName: "Dawarich",
      hostname: publicOrigin.hostname,
      allowPrivateHosts: [internal.hostname],
      apiKey: request.apiKey,
    };
  }

  private async validate(candidate: ResolvedCandidate): Promise<ValidatedMetadata> {
    const client = this.clientFactory({
      baseUrl: candidate.upstreamBaseUrl,
      apiKey: candidate.apiKey,
      allowPrivateHosts: candidate.allowPrivateHosts,
    });
    try {
      const currentUser = await client.getCurrentUser();
      const settings = await client.getSettings();
      const start = this.now();
      const end = new Date(start.getTime() + 60 * 60 * 1000);
      const distanceUnit = settings.settings.maps?.distance_unit ?? null;
      await client.getTimeline(
        { startAt: start.toISOString(), endAt: end.toISOString() },
        distanceUnit ?? "km",
      );
      return {
        upstreamUserId: null,
        upstreamEmail: currentUser.user.email,
        upstreamTimeZone: settings.settings.timezone,
        distanceUnit,
      };
    } catch (error) {
      throw asConnectionError(error);
    }
  }

  private async resolveHealthyManaged(): Promise<ManagedDawarichState> {
    let managed: ManagedDawarichState | null;
    try {
      managed = await this.managedResolver.resolve();
    } catch {
      managed = null;
    }
    if (!managed?.provisioned || !managed.healthy) {
      throw new TimelineConnectionError("TIMELINE_MANAGED_DISABLED");
    }
    return managed;
  }

  private async resolveManagedView(): Promise<TimelineConnectionView["managed"]> {
    let managed: ManagedDawarichState | null;
    try {
      managed = await this.managedResolver.resolve();
    } catch {
      managed = null;
    }
    if (!managed) {
      return { available: false, healthy: false, publicOrigin: null, reason: "disabled" };
    }
    if (!managed.provisioned) {
      return {
        available: false,
        healthy: managed.healthy,
        publicOrigin: null,
        reason: "unprovisioned",
      };
    }
    let publicOrigin: string;
    try {
      publicOrigin = strictOrigin(managed.publicOrigin, "https:").origin;
    } catch {
      return { available: false, healthy: false, publicOrigin: null, reason: "unprovisioned" };
    }
    if (!managed.healthy) {
      return { available: true, healthy: false, publicOrigin, reason: "unhealthy" };
    }
    return { available: true, healthy: true, publicOrigin, reason: null };
  }

  private writeLifecycleAudit(
    userId: string,
    action: string,
    candidate: LifecycleAuditContext | null,
    outcome: "success" | "failure",
  ): Promise<void> {
    return this.audit({
      actorId: userId,
      targetType: "personal_timeline_connection",
      targetId: userId,
      action,
      details: {
        mode: candidate?.mode ?? null,
        hostname: candidate?.hostname ?? null,
        outcome,
      },
    });
  }
}

export const timelineConnectionService = new TimelineConnectionService();
