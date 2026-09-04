import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db as defaultDb } from "../../db/index.js";
import { personalTimelineConnection } from "../../db/schema.js";
import {
  fetchManagedDawarichSubjectExport,
  type ManagedDawarichExportOptions,
} from "../../services/ops-client.js";
import { getSubjectDataRegistration } from "../catalogue.js";
import type { CollectorSourcePart } from "../collectors.js";
import { spoolDawarichTar } from "../dawarich-source-part.js";

export interface ManagedDawarichCollectorContext {
  userId: string;
  cutoffAt: Date;
  database?: typeof defaultDb;
  expectedDawarichUserId?: number | null;
  /** Propagates request cancellation through the ops-agent stream. */
  signal?: AbortSignal;
  fetchExport?: (options: ManagedDawarichExportOptions) => Promise<NodeJS.ReadableStream>;
}

/** Collects the managed timeline only. External Dawarich instances remain a
 * separate controller boundary and are never queried by this collector. */
export async function collectManagedDawarich(
  context: ManagedDawarichCollectorContext,
): Promise<CollectorSourcePart> {
  const registration = getSubjectDataRegistration("managed-dawarich");
  if (!registration) throw new Error("managed-dawarich registration is missing");
  const database = context.database ?? defaultDb;
  const rows = await database
    .select({
      mode: personalTimelineConnection.mode,
      upstreamUserId: personalTimelineConnection.upstreamUserId,
    })
    .from(personalTimelineConnection)
    .where(eq(personalTimelineConnection.userId, context.userId))
    .limit(1);
  const connection = rows[0];
  if (connection?.mode !== "managed") {
    return {
      registrationId: registration.id,
      category: registration.category,
      records: [],
      entries: [],
      outcome: "not_applicable",
      warningCodes: [],
      capturedAt: new Date().toISOString(),
    };
  }
  const expected =
    context.expectedDawarichUserId ??
    (connection.upstreamUserId && /^\d+$/.test(connection.upstreamUserId)
      ? Number(connection.upstreamUserId)
      : null);
  const requestId = randomUUID();
  const fetcher =
    context.fetchExport ??
    ((options) => fetchManagedDawarichSubjectExport(options) as Promise<NodeJS.ReadableStream>);
  try {
    const rights: Array<"access" | "portability"> = ["access"];
    if (registration.portability.decision === "include") rights.push("portability");
    const stream = await fetcher({
      request: {
        version: 1,
        requestId,
        openmapxSubjectId: context.userId,
        expectedDawarichUserId: expected,
        cutoff: context.cutoffAt.toISOString(),
        rights,
      },
      signal: context.signal,
    });
    // The upstream collector receives the exact OpenMapX subject locator.  A
    // cutoff match alone is not enough: validate the manifest's keyed-free
    // subject digest as well, so a buggy or compromised managed container
    // cannot return another account's export under a valid request ID.
    const subjectUserIdDigest = createHash("sha256").update(context.userId).digest("hex");
    const spooled = await spoolDawarichTar(stream as never, {
      expected: { cutoff: context.cutoffAt.toISOString(), subjectUserIdDigest },
    });
    return {
      registrationId: registration.id,
      category: registration.category,
      records: [],
      entries: spooled.entries,
      disposeSources: spooled.dispose,
      outcome: "included",
      warningCodes: [],
      capturedAt: new Date().toISOString(),
    };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "collector-failed";
    const notApplicable = code === "not_found";
    return {
      registrationId: registration.id,
      category: registration.category,
      records: [],
      outcome: notApplicable ? "not_applicable" : "unavailable",
      warningCodes: [code.replace(/[^a-z0-9._-]/gi, "-").slice(0, 128)],
      capturedAt: new Date().toISOString(),
    };
  }
}
