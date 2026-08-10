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
  send(type: "snapshot.update" | "navigation.event", payload: unknown): boolean;
  now: () => number;
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
    event: async (eventId) => {
      const session = await deps.repository.loadActive(deps.now());
      if (!session) return;
      const pending = await deps.repository.listPendingEvents(session.sessionId);
      const event = pending.find((entry) => entry.eventId === eventId);
      // The event stays in the outbox until the page acknowledges it, so a
      // failed delivery here is simply retried on the next handshake.
      if (event) deps.send("navigation.event", { eventId, event: event.payload });
    },
  };

  return { port, publisher };
}
