import type { OverlayId, OverlaySnapshotEntry } from "./overlayRegistry";
import { restoreOverlaySnapshot, runOverlayTransaction } from "./overlayRegistry";

export interface ContextualOverlayOwnership {
  /**
   * Claims automation ownership of `overlayId` for `ownerKey`. The first
   * claim (no other owner currently holds this overlay) opens it — closing
   * exclusion peers through the normal transaction path — and snapshots the
   * whole displaced closure so release() can restore it later. A second
   * simultaneous owner (a different `ownerKey`, or the same one reacquiring)
   * just adds to the refcount; the original snapshot stays authoritative, so
   * only the first claim's prior state is ever restored.
   */
  acquire: (overlayId: OverlayId, ownerKey: string) => void;
  /**
   * Releases `ownerKey`'s claim. Only once the last owner has released does
   * this restore the pre-acquire snapshot — and even then, only for entries
   * whose userRevision hasn't moved since the snapshot was taken; a userRevision
   * that moved means a direct (user/external) write happened in between, and
   * that write wins over the restore.
   */
  release: (overlayId: OverlayId, ownerKey: string) => void;
  /**
   * Releases every held overlay for every owner, restoring each unmodified
   * snapshot. For teardown (unmount) paths, where walking the exact set of
   * (overlayId, ownerKey) pairs a caller acquired would mean the caller
   * keeping its own duplicate bookkeeping just to unwind this one.
   */
  releaseAll: () => void;
}

interface HeldOverlay {
  owners: Set<string>;
  snapshot: OverlaySnapshotEntry[];
}

/**
 * A refcounted automation-ownership tracker for the overlay registry's
 * exclusion-aware transactions. `sessionOwner` identifies the automation
 * instance (a ContextualOverlays mount, a cycling auto-overlay session) that
 * every transaction this tracker issues is tagged with; `ownerKey` is a
 * finer-grained id scoped to this tracker alone (e.g. which contextual rule
 * currently wants the overlay), used only to decide when the LAST reason to
 * hold an overlay has gone away.
 */
export function createContextualOverlayOwnership(sessionOwner: string): ContextualOverlayOwnership {
  const held = new Map<OverlayId, HeldOverlay>();

  function acquire(overlayId: OverlayId, ownerKey: string): void {
    const existing = held.get(overlayId);
    if (existing) {
      existing.owners.add(ownerKey);
      return;
    }

    const record = runOverlayTransaction(
      overlayId,
      { panelOpen: true },
      { kind: "automation", owner: sessionOwner },
    );
    if (!record) return;
    held.set(overlayId, { owners: new Set([ownerKey]), snapshot: record.before });
  }

  function release(overlayId: OverlayId, ownerKey: string): void {
    const existing = held.get(overlayId);
    if (!existing) return;
    existing.owners.delete(ownerKey);
    if (existing.owners.size > 0) return;
    held.delete(overlayId);
    restoreOverlaySnapshot(existing.snapshot);
  }

  function releaseAll(): void {
    const snapshots = Array.from(held.values());
    held.clear();
    for (const entry of snapshots) restoreOverlaySnapshot(entry.snapshot);
  }

  return { acquire, release, releaseAll };
}
