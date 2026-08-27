export type DataManagerStartupPhase =
  | "offline-storage"
  | "redis"
  | "job-reconciliation"
  | "poi-source-discovery"
  | "cron-schedulers"
  | "complete";

export interface DataManagerReadinessSnapshot {
  status: "starting" | "ready" | "failed";
  phase: DataManagerStartupPhase;
}

export class DataManagerReadiness {
  #snapshot: DataManagerReadinessSnapshot = {
    status: "starting",
    phase: "offline-storage",
  };

  setPhase(phase: Exclude<DataManagerStartupPhase, "complete">): void {
    this.#snapshot = { status: "starting", phase };
  }

  markReady(): void {
    this.#snapshot = { status: "ready", phase: "complete" };
  }

  markFailed(): void {
    this.#snapshot = { ...this.#snapshot, status: "failed" };
  }

  snapshot(): DataManagerReadinessSnapshot {
    return { ...this.#snapshot };
  }
}
