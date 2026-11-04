import type { MobileNavigationSession } from "@openmapx/core/navigation";
import { projectSurface } from "./projectSurface";
import { SURFACE_INTERVAL_MS, type SurfaceModel } from "./surfaceModel";
export interface SurfaceAdapter {
  update(model: SurfaceModel, foreground: boolean): Promise<unknown>;
  clear(expectedOwner: string | null): Promise<unknown>;
}
/** OS work has its own FIFO. Never enter the coordinator executor from an effect. */
export class SurfaceController {
  private tail: Promise<void> = Promise.resolve();
  private owner: string | null = null;
  private revision = -1;
  private fingerprint = "";
  private lastAt = -Infinity;
  private cleared = false;
  private generation = 0;
  constructor(
    private readonly adapter: SurfaceAdapter,
    private readonly now = Date.now,
  ) {}
  reconcile(session: MobileNavigationSession | null, foreground: boolean): Promise<void> {
    const model =
      session?.permissionMode === "foreground-only" && !foreground
        ? null
        : projectSurface(session, this.now());
    const work = this.tail.then(async () => {
      const generation = ++this.generation;
      if (!model) {
        if (this.cleared) return;
        await this.adapter.clear(this.owner);
        if (generation !== this.generation) return;
        this.owner = null;
        this.revision = -1;
        this.fingerprint = "";
        this.cleared = true;
        return;
      }
      if (model.sessionId === this.owner && model.revision < this.revision) return;
      const signature = JSON.stringify([
        model.sessionId,
        model.status,
        model.title,
        model.instruction,
        foreground,
      ]);
      if (signature === this.fingerprint && this.now() - this.lastAt < SURFACE_INTERVAL_MS) return;
      if (this.owner !== model.sessionId) {
        this.revision = -1;
        this.fingerprint = "";
        this.lastAt = -Infinity;
      }
      this.owner = model.sessionId;
      this.cleared = false;
      const result = await this.adapter.update(model, foreground);
      // A failed/foreground-deferred ActivityKit start must be retryable.
      if (result === false || generation !== this.generation) return;
      this.revision = model.revision;
      this.fingerprint = signature;
      this.lastAt = this.now();
    });
    // A missing/broken OS adapter never strands the navigation executor.
    const bounded = boundSurfaceWork(work);
    this.tail = bounded.catch(() => undefined);
    return this.tail;
  }
  settle(): Promise<void> {
    return this.tail;
  }
}
function boundSurfaceWork(work: Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => resolve(), 3000);
    void work.then(
      () => {
        clearTimeout(timeout);
        resolve();
      },
      (e) => {
        clearTimeout(timeout);
        reject(e);
      },
    );
  });
}
