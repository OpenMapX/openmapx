import { MOBILE_PROTOCOL_MAX, routeFingerprint } from "@openmapx/core/navigation";
import { groundFullSnapshot, groundProgressSnapshot } from "../navigation/snapshots/groundSnapshot";
import type { SessionRepository } from "../storage/SessionRepository";
import { buildCarTripProjection } from "./CarTripProjection";
import { nativeCar } from "./nativeCar";

let sequence = 0;
let pending: ReturnType<typeof setTimeout> | null = null;
let queue = Promise.resolve();
let last: { id: string; revision: number; at: number; fingerprint?: string } | null = null;
/** Read committed state independently of whether the phone document accepted its message. */
export function publishCarState(
  repository: SessionRepository,
  now: number,
  immediate = false,
  forceFull = false,
): Promise<void> {
  const work = queue.then(() => publish(repository, now, immediate, forceFull));
  queue = work.catch(() => {});
  return work;
}
async function publish(
  repository: SessionRepository,
  now: number,
  immediate: boolean,
  forceFull: boolean,
): Promise<void> {
  const native = nativeCar();
  if (!native) return;
  const session = await repository.loadActive(now);
  if (session?.kind !== "ground" || session.status !== "active") {
    if (pending) clearTimeout(pending);
    pending = null;
    const terminalSession =
      session?.kind === "ground" &&
      ["arrived", "stopped", "expired", "error"].includes(session.status)
        ? session
        : null;
    const previous =
      last ??
      (terminalSession
        ? { id: terminalSession.sessionId, revision: terminalSession.revision, at: now }
        : null);
    last = null;
    const ack = previous ? await repository.readTerminalAck(previous.id) : null;
    await native.publish(
      JSON.stringify({
        projection: null,
        message: previous
          ? {
              protocolVersion: MOBILE_PROTOCOL_MAX,
              type: "session.stopped",
              messageId: `car-${++sequence}`,
              channelNonce: "car-native",
              sentAtMs: now,
              payload: {
                sessionId: previous.id,
                revision: ack?.finalRevision ?? terminalSession?.revision ?? previous.revision,
                finalStatus: ack?.finalStatus ?? terminalSession?.status ?? "stopped",
              },
            }
          : null,
      }),
    );
    return;
  }
  if (last?.id === session.sessionId) {
    if (session.revision < last.revision) return;
    if (!immediate && now - last.at < 1000) {
      if (!pending)
        pending = setTimeout(
          () => {
            pending = null;
            void publishCarState(repository, Date.now(), false).catch(() => {});
          },
          1000 - (now - last.at),
        );
      return;
    }
  }
  if (pending) clearTimeout(pending);
  pending = null;
  const fingerprint = routeFingerprint(session.payload.startPackage.route.geometry);
  const fullNeeded =
    forceFull || immediate || last?.id !== session.sessionId || last.fingerprint !== fingerprint;
  const snapshot = fullNeeded ? groundFullSnapshot(session) : groundProgressSnapshot(session);
  const next = { id: session.sessionId, revision: session.revision, at: now, fingerprint };
  await native.publish(
    JSON.stringify({
      projection: buildCarTripProjection(
        {
          ...snapshot,
          route: session.payload.startPackage.route,
          locale: session.locale,
          units: session.units,
        },
        now,
      ),
      message: {
        protocolVersion: MOBILE_PROTOCOL_MAX,
        type: "snapshot.update",
        messageId: `car-${++sequence}`,
        channelNonce: "car-native",
        sentAtMs: now,
        payload: { snapshot },
        sessionId: session.sessionId,
        revision: session.revision,
      },
    }),
  );
  last = next;
}
