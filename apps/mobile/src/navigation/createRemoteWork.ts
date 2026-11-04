import type { SessionRepository } from "../storage/SessionRepository";
import type { RemoteWorkPort } from "./effects";
import type { RerouteOutcome } from "./ground/GroundRerouteService";
import type { RefreshOutcome, TransitRefreshService } from "./transit/TransitRefreshService";

/**
 * Runs the network requests a session asks for, off the coordinator's queue.
 *
 * An effect only starts the request. Its answer re-enters through the
 * coordinator as a queued mutation bound to the request it answers, so a slow
 * response never holds up location fixes and a stale one is discarded there.
 */

export interface RerouteClient {
  request(request: {
    requestId: string;
    session: Extract<
      NonNullable<Awaited<ReturnType<SessionRepository["loadActive"]>>>,
      { kind: "ground" }
    >;
    origin: [number, number];
  }): Promise<RerouteOutcome>;
  abortAll(): void;
}

export interface RemoteWorkDeps {
  repository: Pick<SessionRepository, "loadActive">;
  reroute: RerouteClient;
  applyReroute(outcome: RerouteOutcome): Promise<void>;
  transitRefresh?: Pick<TransitRefreshService, "request" | "abortAll">;
  applyTransitRefresh?(outcome: RefreshOutcome): Promise<void>;
  now(): number;
  diagnostics: { record(type: string, fields: Record<string, unknown>): void };
}

export interface RemoteWork {
  port: RemoteWorkPort;
  /** Settles once every request started so far has been answered. Test seam. */
  idle(): Promise<void>;
  /** Abandons everything in flight, e.g. when the composition is torn down. */
  abortAll(): void;
}

export function createRemoteWork(deps: RemoteWorkDeps): RemoteWork {
  const inFlight = new Set<Promise<void>>();

  const track = (work: Promise<void>) => {
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  };

  const port: RemoteWorkPort = {
    reroute: async (requestId) => {
      const session = await deps.repository.loadActive(deps.now());
      if (session?.kind !== "ground" || session.status !== "active") return;
      if (session.payload.reroute.requestId !== requestId) return;
      // The raw fix, not the position snapped to the route being abandoned.
      const origin = session.lastAcceptedFix?.coords;
      if (!origin) return;

      // One reroute at a time: a newer request supersedes the one in flight,
      // whose answer would be dropped anyway.
      deps.reroute.abortAll();
      track(
        deps.reroute
          .request({ requestId, session, origin: [origin[0], origin[1]] })
          .then((outcome) => deps.applyReroute(outcome))
          .catch(() => {
            deps.diagnostics.record("typed.error", { scope: "reroute-request" });
          }),
      );
    },
    // Live updates preserve the captured journey until their guarded result commits.
    transitRefresh: async (requestId) => {
      const session = await deps.repository.loadActive(deps.now());
      if (
        session?.kind !== "transit" ||
        session.status !== "active" ||
        session.payload.refresh.requestId !== requestId ||
        !deps.transitRefresh
      )
        return;
      track(
        deps.transitRefresh
          .request({ session, requestId, generation: session.payload.refresh.generation })
          .then((outcome) => deps.applyTransitRefresh?.(outcome))
          .catch(() => {
            deps.diagnostics.record("typed.error", { scope: "transit-refresh" });
          }),
      );
    },
  };

  return {
    port,
    idle: async () => {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
    abortAll: () => {
      deps.reroute.abortAll();
      deps.transitRefresh?.abortAll();
    },
  };
}
