import {
  DataExecutionPartialResult,
  retainOwnedDataTransitCandidate,
} from "@openmapx/core/build-artifacts";
import type {
  DataExecutionInput,
  DataExecutionResult,
} from "@openmapx/core/data-manager-contracts";
import type postgres from "postgres";
import { asJobLogger, jobChildLogger } from "../../logger.js";
import type { StateStore } from "../../state.js";
import { convertPbfToBz2ForRegion } from "../convert-overpass.js";
import { downloadFonts } from "../download-fonts.js";
import { downloadOsm } from "../download-osm.js";
import { buildNotablePlaces } from "../notable-places/build.js";
import { notablePlacesSettings } from "../notable-places/schedule.js";
import { createNotablePlacesRuntimeState } from "../notable-places/state.js";
import { extractOsmPois } from "../overture/extract-osm-pois.js";
import { writeOvertureFeedState } from "../overture/feed-state.js";
import { ingestOverture } from "../overture/ingest.js";
import { withOvertureOperationLock } from "../overture/operation-lock.js";
import { assertValidRegion, pullOverture } from "../overture/pull.js";
import {
  getOvertureConflationState,
  rebuildOvertureLinksUnlocked,
} from "../overture/rebuild-links.js";
import {
  finalizeOvertureReleaseFiles,
  overtureReleaseRetentionFromEnv,
} from "../overture/retention.js";
import { syncOvertureRegion } from "../overture/sync.js";
import { buildOsmSearchIndex } from "../search-index/build.js";
import {
  createNotablePlacesOperationLock,
  createSearchIndexOperationLock,
} from "../search-index/operation-lock.js";
import {
  createSearchIndexRuntimeState,
  fingerprintDataset,
  updateCurrentSearchIndexFingerprint,
} from "../search-index/state.js";
import type { MotisOperationsPolicy } from "../transitous/operations-profile.js";
import { getOperatorFeedRelayStore } from "../transitous/operator-feed-relay.js";
import { makePersistingOnStageComplete } from "../transitous/persistence.js";
import { buildJobContext, runTransitousPipeline } from "../transitous/pipeline.js";
import type { SingleFlightController } from "../transitous/single-flight.js";
import { dataExecutionDiagnostic } from "./diagnostics.js";
import { runOwnedDataOpsOperation } from "./ops-children.js";
import type { DataExecutionContext } from "./runtime.js";
import { publishOwnedTransitSourceMutation } from "./source-mutation.js";
import {
  DataPublicationUnknown,
  publishDataChange,
  retainDataPublication,
} from "./worker-scope.js";

type Event = Record<string, unknown>;
export function createDataExecutionDispatcher(deps: {
  dataDir: string;
  state: StateStore;
  sql: postgres.Sql;
  singleFlight: SingleFlightController;
  operationsPolicy: MotisOperationsPolicy;
  runHardlinks: (context: DataExecutionContext) => Promise<DataExecutionResult>;
  notablePlaces?: {
    runtimeState: ReturnType<typeof createNotablePlacesRuntimeState>;
    operationLock: ReturnType<typeof createNotablePlacesOperationLock>;
  };
}) {
  const listeners = new Map<string, Set<(event: Event) => void>>(),
    done = new Map<string, Event>();
  const searchState = createSearchIndexRuntimeState(),
    searchLock = createSearchIndexOperationLock(deps.sql),
    notableState = deps.notablePlaces?.runtimeState ?? createNotablePlacesRuntimeState(),
    notableLock = deps.notablePlaces?.operationLock ?? createNotablePlacesOperationLock(deps.sql);
  function emit(id: string, event: Event) {
    for (const fn of listeners.get(id) ?? []) fn(event);
  }
  function finish(id: string, result: Event) {
    done.set(id, result);
    while (done.size > 1024) done.delete(done.keys().next().value!);
  }
  async function dispatch(
    input: DataExecutionInput,
    context: DataExecutionContext,
  ): Promise<DataExecutionResult> {
    if ("region" in input) assertValidRegion(input.region);
    const common = {
      dataDir: deps.dataDir,
      signal: context.signal,
      onProgress: (message: string) =>
        emit(context.execution.executionId, { event: "progress", message }),
    };
    switch (input.kind) {
      case "download-osm": {
        const result = await downloadOsm({
          ...common,
          region: input.region,
          store: deps.state,
          onProgress: (bytes, totalBytes) =>
            emit(context.execution.executionId, { event: "progress", bytes, totalBytes }),
          withPublishLock: (publish) =>
            withOvertureOperationLock(async () => {
              context.assertForward();
              publish();
            }),
        });
        const dataset = deps.state
          .getAll()
          .find((entry) => entry.type === "osm-pbf" && (entry.region ?? entry.id) === input.region);
        if (dataset)
          try {
            await updateCurrentSearchIndexFingerprint(
              deps.sql,
              input.region,
              await fingerprintDataset(dataset),
            );
          } catch (error) {
            if (error instanceof DataPublicationUnknown) throw error;
            jobChildLogger({ job: "download-osm", jobId: context.execution.executionId }).warn(
              "download-osm: could not update current search-index fingerprint",
            );
          }
        await retainDataPublication();
        finish(context.execution.executionId, { event: "done", ok: true, ...result });
        return {
          kind: input.kind,
          region: input.region,
          sizeBytes: result.sizeBytes,
          ...(result.md5 ? { md5: result.md5 } : {}),
        };
      }
      case "download-fonts":
        await downloadFonts({ ...common, store: deps.state });
        await retainDataPublication();
        finish(context.execution.executionId, { event: "done", ok: true });
        return { kind: input.kind, completed: true };
      case "convert-overpass": {
        const result = await convertPbfToBz2ForRegion({
          ...common,
          region: input.region,
          store: deps.state,
          onProgress: (bytes, totalBytes) =>
            emit(context.execution.executionId, { event: "progress", bytes, totalBytes }),
        });
        await retainDataPublication();
        finish(context.execution.executionId, { event: "done", ok: true, ...result });
        return { kind: input.kind, region: input.region, sizeBytes: result.sizeBytes };
      }
      case "transit-sync": {
        if (
          deps.operationsPolicy.profile !== "planet" &&
          input.countries.some((country) => !deps.operationsPolicy.countries.includes(country))
        )
          throw Error("Countries outside configured operations profile");
        if (!deps.singleFlight.reserveOwned(context.execution.executionId))
          throw Error("Transit reservation is busy");
        const logger = asJobLogger(
          jobChildLogger({ job: "transit-sync", jobId: context.execution.executionId }),
        );
        try {
          await publishOwnedTransitSourceMutation(
            input,
            context,
            deps.operationsPolicy,
            deps.dataDir,
          );
          const ctx = await publishDataChange(() =>
            buildJobContext({
              dataDir: deps.dataDir,
              store: deps.state,
              countries: input.countries,
              source: deps.operationsPolicy.acquisition,
              operationsPolicy: { ...deps.operationsPolicy, countries: input.countries },
              jobId: context.execution.executionId,
              logger,
              abortSignal: context.signal,
              executionContext: context,
              operatorFeedRelay: getOperatorFeedRelayStore(),
              onStageComplete: async (stage) => {
                await makePersistingOnStageComplete(context.execution.executionId, logger)(stage);
                const diagnostic = dataExecutionDiagnostic(stage.message ?? stage.stage);
                await context.checkpoint({
                  diagnostics: {
                    tail: [{ stream: "stdout", message: diagnostic.message }],
                    truncated: diagnostic.truncated,
                  },
                });
              },
            }),
          );
          const result = await runTransitousPipeline(ctx);
          finish(context.execution.executionId, {
            event: "done",
            ok: result.finalStatus !== "error",
            ...result,
          });
          const sourceRevision = ctx.state.transitousLock?.ref ?? "unavailable";
          if (sourceRevision === "unavailable")
            throw Error("Transit source revision was not retained");
          return {
            kind: input.kind,
            finalStatus: result.finalStatus === "skipped" ? "error" : result.finalStatus,
            sourceRevision,
            countries: input.countries,
          };
        } finally {
          deps.singleFlight.markSyncFinished(context.execution.executionId);
        }
      }
      case "overture-pull": {
        const path = await pullOverture({ ...common, region: input.region });
        finish(context.execution.executionId, { event: "done", ok: true, path });
        return { kind: input.kind, region: input.region, metrics: {} };
      }
      case "overture-ingest":
        await withOvertureOperationLock(() => ingestOverture({ ...common, region: input.region }));
        finish(context.execution.executionId, { event: "done", ok: true });
        return { kind: input.kind, region: input.region, metrics: {} };
      case "overture-extract":
        await withOvertureOperationLock(() => extractOsmPois({ ...common, region: input.region }));
        finish(context.execution.executionId, { event: "done", ok: true });
        return { kind: input.kind, region: input.region, metrics: {} };
      case "overture-conflate": {
        const result = await withOvertureOperationLock(async () => {
          const installed = await getOvertureConflationState();
          if (!installed) throw Error("No installed Overture release");
          const result = await rebuildOvertureLinksUnlocked({
            ...common,
            region: input.region,
            release: installed.release,
            force: input.restart === true,
            ollamaUrl: process.env.OLLAMA_URL ?? "http://local-ai:11434",
            useEmbeddings: false,
          });
          if (result.status === "completed" || result.status === "already_completed")
            await finalizeOvertureReleaseFiles({
              dataDir: deps.dataDir,
              activeRelease: installed.release,
              retain: overtureReleaseRetentionFromEnv(process.env.OVERTURE_RELEASE_RETENTION),
              onProgress: common.onProgress,
            });
          return result;
        });
        finish(context.execution.executionId, {
          event: "done",
          ok: result.status !== "failed" && result.status !== "waiting_for_osm",
          ...result,
        });
        if (
          result.status === "failed" ||
          result.status === "waiting_for_osm" ||
          result.status === "already_running"
        )
          throw Error("Overture conflation did not complete");
        return { kind: input.kind, region: input.region, metrics: { processed: result.linked } };
      }
      case "overture-sync": {
        const result = await syncOvertureRegion({ ...common, region: input.region });
        await writeOvertureFeedState(
          input.region,
          result.release,
          asJobLogger(
            jobChildLogger({ job: "overture-sync", jobId: context.execution.executionId }),
          ),
        );
        const incomplete = ["failed", "waiting_for_osm", "already_running"].includes(
          result.conflation,
        );
        finish(context.execution.executionId, { event: "done", ok: !incomplete, ...result });
        const safe = {
          kind: input.kind,
          region: input.region,
          release: result.release,
          metrics: { processed: result.linked },
        };
        if (incomplete) {
          const diagnostic = dataExecutionDiagnostic(
            result.conflationError ?? `Conflation ${result.conflation}`,
          );
          await context.checkpoint({
            diagnostics: {
              tail: [{ stream: "stderr", message: diagnostic.message }],
              truncated: diagnostic.truncated,
            },
          });
          throw new DataExecutionPartialResult(safe);
        }
        return safe;
      }
      case "search-index-build": {
        const result = await buildOsmSearchIndex({
          ...common,
          region: input.region,
          store: deps.state,
          sql: deps.sql,
          runtimeState: searchState,
          operationLock: searchLock,
          onProgress: (progress) =>
            emit(context.execution.executionId, { event: "progress", ...progress }),
        });
        finish(context.execution.executionId, { event: "done", ok: true, ...result });
        return {
          kind: input.kind,
          region: input.region,
          metrics: { processed: result.placeCount },
        };
      }
      case "notable-places-build": {
        const result = await buildNotablePlaces({
          ...notablePlacesSettings(),
          sql: deps.sql,
          signal: context.signal,
          runtimeState: notableState,
          operationLock: notableLock,
          onProgress: (progress) =>
            emit(context.execution.executionId, { event: "progress", ...progress }),
        });
        finish(context.execution.executionId, { event: "done", ok: true, ...result });
        return { kind: input.kind, metrics: { processed: result.placeCount } };
      }
      case "generation-hardlinks":
        return deps.runHardlinks(context);
      case "transit-maintenance": {
        const slot = (await context.record()).reservations[0];
        if (!slot) throw Error("Maintenance child reservation missing");
        if (input.action === "reload-feed-proxy")
          retainOwnedDataTransitCandidate(context.authority, slot);
        await runOwnedDataOpsOperation(slot.operation, {
          context,
          phase: slot.phase,
          ordinal: slot.ordinal,
          serviceIds: slot.serviceIds,
        });
        return { kind: input.kind, action: input.action, changed: true };
      }
    }
  }
  return {
    dispatch,
    searchIndexRuntimeState: searchState,
    legacyResult: (id: string) => done.get(id),
    subscribe(id: string, fn: (event: Event) => void) {
      let group = listeners.get(id);
      if (!group) {
        group = new Set();
        listeners.set(id, group);
      }
      group.add(fn);
      return () => {
        group.delete(fn);
        if (!group.size) listeners.delete(id);
      };
    },
  };
}
