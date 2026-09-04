import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { db as defaultDb } from "../db/index.js";
import { dataSubjectRequestEvent } from "../db/schema.js";
import { eventPayloadSchema } from "./request-contracts.js";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/;
const EVENT_TYPE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export class PrivacyIdempotencyError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REUSED";
  readonly statusCode = 409;

  constructor() {
    super("idempotency key was already used for another operation");
    this.name = "PrivacyIdempotencyError";
  }
}

export function assertIdempotencyKey(value: string): string {
  if (!IDEMPOTENCY_KEY.test(value)) throw new PrivacyIdempotencyError();
  return value;
}

export function idempotencyFingerprint(value: unknown): string {
  // Keep only a digest in the ledger; raw request payloads may contain
  // exceptional personal data or attachment bytes.
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "null")
    .digest("hex");
}

function payloadFingerprint(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const value = (payload as Record<string, unknown>).operationDigest;
  return typeof value === "string" ? value : undefined;
}

export async function findIdempotentEvent(
  database: typeof defaultDb,
  input: { requestId: string; idempotencyKey: string; eventType: string; operationDigest?: string },
) {
  if (!IDEMPOTENCY_KEY.test(input.idempotencyKey) || !EVENT_TYPE.test(input.eventType))
    throw new PrivacyIdempotencyError();
  const rows = await database
    .select()
    .from(dataSubjectRequestEvent)
    .where(
      and(
        eq(dataSubjectRequestEvent.requestId, input.requestId),
        eq(dataSubjectRequestEvent.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  const event = rows[0];
  if (!event) return undefined;
  if (event.eventType !== input.eventType) throw new PrivacyIdempotencyError();
  if (
    input.operationDigest !== undefined &&
    payloadFingerprint(event.payload) !== input.operationDigest
  )
    throw new PrivacyIdempotencyError();
  return event;
}

export async function recordIdempotentEvent(
  database: typeof defaultDb,
  input: {
    requestId: string;
    idempotencyKey: string;
    eventType: string;
    actorKind: string;
    actorId?: string | null;
    payload?: Record<string, unknown>;
    operationDigest?: string;
  },
): Promise<void> {
  if (!IDEMPOTENCY_KEY.test(input.idempotencyKey) || !EVENT_TYPE.test(input.eventType))
    throw new PrivacyIdempotencyError();
  const payload = eventPayloadSchema.parse({
    ...(input.payload ?? {}),
    ...(input.operationDigest ? { operationDigest: input.operationDigest } : {}),
  });
  try {
    await database.insert(dataSubjectRequestEvent).values({
      id: randomUUID(),
      requestId: input.requestId,
      eventType: input.eventType,
      actorKind: input.actorKind.slice(0, 32),
      actorId: input.actorId ? input.actorId.slice(0, 256) : null,
      payloadVersion: 1,
      payload,
      idempotencyKey: input.idempotencyKey,
      createdAt: new Date(),
    });
  } catch (error) {
    if (String(error).includes("data_subject_request_event_idempotency_idx")) {
      await findIdempotentEvent(database, {
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        eventType: input.eventType,
        ...(input.operationDigest ? { operationDigest: input.operationDigest } : {}),
      });
      return;
    }
    throw error;
  }
}
