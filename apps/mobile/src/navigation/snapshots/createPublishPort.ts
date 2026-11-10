import type { NativeToWebPayload } from "@openmapx/core/navigation";
import { publishCarState } from "../../car/publishCarState";
import type { SessionRepository } from "../../storage/SessionRepository";
import type { PublishPort } from "../effects";
import { groundFullSnapshot, groundProgressSnapshot } from "./groundSnapshot";
import { SnapshotPublisher } from "./SnapshotPublisher";
import { transitFullSnapshot, transitProgressSnapshot } from "./transitSnapshot";

/**
 * The publish side of the effect runner.
 *
 * Snapshots are always built from the *authoritative* session read back out of
 * storage, never from whatever the caller happened to be holding. That is what
 * makes a snapshot after a reload correct by construction: the page gets what
 * was committed, not a memory of what someone intended to commit.
 */

export interface PublishPortDeps {
  repository: SessionRepository;
  /** Sends a native-to-web message; false when no document can receive it. */
  send(type: "snapshot.update", payload: NativeToWebPayload<"snapshot.update">): boolean;
  now: () => number;
  reconcileSurface?: () => Promise<void>;
}

export interface PublishPortHandle {
  port: PublishPort;
  publisher: SnapshotPublisher;
}

export function createPublishPort(deps: PublishPortDeps): PublishPortHandle {
  const publisher = new SnapshotPublisher({
    deliver: (snapshot) => deps.send("snapshot.update", { snapshot }),
    now: deps.now,
  });

  const port: PublishPort = {
    snapshot: async (immediate) => {
      // Independent of bridge availability, including a terminal/no-row state.
      await deps.reconcileSurface?.().catch(() => undefined);
      try {
        await publishCarState(deps.repository, deps.now(), immediate);
      } catch {
        /* Car renderer failure must not suppress phone delivery. */
      }
      const session = await deps.repository.loadActive(deps.now());
      if (!session) return;

      // A full snapshot for anything that changed what the page is rendering
      // against; a delta for ordinary movement along something it already has.
      const snapshot =
        session.kind === "ground"
          ? immediate
            ? groundFullSnapshot(session)
            : groundProgressSnapshot(session)
          : immediate
            ? transitFullSnapshot(session)
            : transitProgressSnapshot(session);
      publisher.offer(snapshot, { immediate });
    },
  };

  return { port, publisher };
}
