import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { StateStore } from "../state.js";
import { type CollectCoverageOptions, collectCoverageSnapshot } from "./collect.js";
import { CoverageSnapshotStore } from "./snapshot-store.js";

const SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_OFFSET = 10_000_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface CoverageEvidenceQuery {
  snapshotId?: string;
  offset?: string;
  limit?: string;
}

export interface CoverageApiOptions {
  dataDir: string;
  sql: CollectCoverageOptions["sql"];
  stateStore: StateStore;
  snapshotStore?: CoverageSnapshotStore;
}

function invalid(reply: FastifyReply, error: string): void {
  reply.code(400).send({ error });
}

function parseInteger(
  raw: string | undefined,
  fallback: number,
  field: string,
  max: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${field} must be a non-negative integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`${field} is out of bounds`);
  }
  return value;
}

export function createCoverageSnapshotStore(options: CoverageApiOptions): CoverageSnapshotStore {
  return new CoverageSnapshotStore({
    collect: () =>
      collectCoverageSnapshot({
        dataDir: options.dataDir,
        sql: options.sql,
        store: options.stateStore,
      }),
  });
}

export function registerCoverageEvidenceRoute(
  app: FastifyInstance,
  options: CoverageApiOptions,
): CoverageSnapshotStore {
  const snapshotStore = options.snapshotStore ?? createCoverageSnapshotStore(options);

  app.get<{ Querystring: CoverageEvidenceQuery }>(
    "/coverage/evidence",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            snapshotId: {
              type: "string",
              minLength: 1,
              maxLength: 128,
              pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
            },
            offset: { type: "string", pattern: "^[0-9]{1,8}$" },
            limit: { type: "string", pattern: "^[0-9]{1,3}$" },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: CoverageEvidenceQuery }>, reply) => {
      reply.header("Cache-Control", "private, no-store");
      reply.header("Pragma", "no-cache");

      const { snapshotId } = request.query;
      if (snapshotId !== undefined && !SNAPSHOT_ID_PATTERN.test(snapshotId)) {
        invalid(reply, "snapshotId is malformed or too long");
        return;
      }

      let offset: number;
      let limit: number;
      try {
        offset = parseInteger(request.query.offset, 0, "offset", MAX_OFFSET);
        limit = parseInteger(request.query.limit, DEFAULT_LIMIT, "limit", MAX_LIMIT);
        if (offset > 0 && !snapshotId)
          throw new Error("snapshotId is required for continuation pages");
        if (limit < 1) throw new Error("limit must be at least 1");
      } catch (error) {
        invalid(reply, (error as Error).message);
        return;
      }

      try {
        const snapshot = snapshotId ? snapshotStore.get(snapshotId) : await snapshotStore.latest();
        if (!snapshot) return reply.code(409).send({ error: "snapshot_expired" });
        return reply.send(snapshotStore.page(snapshot, { offset, limit }));
      } catch (error) {
        request.log.error({ err: error }, "coverage evidence collection failed");
        return reply.code(503).send({ error: "coverage_unavailable" });
      }
    },
  );

  return snapshotStore;
}
