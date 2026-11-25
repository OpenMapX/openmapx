import type { FastifyInstance } from "fastify";
import { registerDataManagerRoute } from "../route-contract.js";
import type { StateStore } from "../state.js";
import { type CollectCoverageOptions, collectCoverageSnapshot } from "./collect.js";
import { CoverageSnapshotStore } from "./snapshot-store.js";

export interface CoverageApiOptions {
  dataDir: string;
  sql: CollectCoverageOptions["sql"];
  stateStore: StateStore;
  snapshotStore?: CoverageSnapshotStore;
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
  registerDataManagerRoute(app, "getCoverageEvidence", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    reply.header("Pragma", "no-cache");
    const { snapshotId, offset = 0, limit = 50 } = request.query;
    try {
      const snapshot = snapshotId ? snapshotStore.get(snapshotId) : await snapshotStore.latest();
      if (!snapshot)
        return reply
          .code(409)
          .send({ error: "Coverage snapshot expired", code: "SNAPSHOT_EXPIRED" });
      return reply.send(snapshotStore.page(snapshot, { offset, limit }));
    } catch (error) {
      request.log.error({ err: error }, "coverage evidence collection failed");
      return reply
        .code(503)
        .send({ error: "Coverage evidence is unavailable", code: "COVERAGE_UNAVAILABLE" });
    }
  });
  return snapshotStore;
}
