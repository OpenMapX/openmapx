import {
  type AdminActivityJobDetail,
  type AdminActivityJobLog,
  type AdminActivityJobStage,
  adminActivityJobDetailSchema,
} from "@openmapx/core/api-contracts";

export const timestamp = "2026-09-06T08:00:00.000Z";
export function job(overrides: Partial<AdminActivityJobDetail> = {}): AdminActivityJobDetail {
  return adminActivityJobDetailSchema.parse({
    source: "application",
    id: "job-1",
    type: "data.operation",
    status: "running",
    payload: null,
    result: null,
    error: null,
    progress: 10,
    createdBy: null,
    actorLabel: "System",
    createdAt: timestamp,
    startedAt: timestamp,
    finishedAt: null,
    cancelable: true,
    logs: [],
    stages: [],
    ...overrides,
  });
}
export function log(id: string, seq: number): AdminActivityJobLog {
  return { id, jobId: "job-1", seq, stream: "stdout", line: id, createdAt: timestamp };
}

export function stage(jobId: string): AdminActivityJobStage {
  return {
    id: "stage-1",
    jobId,
    stage: "validate",
    status: "partial",
    startedAt: timestamp,
    finishedAt: timestamp,
    durationMs: 1250,
    message: "Validation completed",
    error: { code: "invalid_archives" },
    artifacts: { invalid: [{ id: "archive-1", reason: "Invalid format" }] },
  };
}

export class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = FakeEventSource.CONNECTING;
  closed = false;
  constructor(
    readonly url: string,
    readonly init?: EventSourceInit,
  ) {
    super();
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
  open() {
    this.readyState = FakeEventSource.OPEN;
    this.dispatchEvent(new Event("open"));
  }
  emit(name: string, data: unknown) {
    this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) }));
  }
  fail() {
    this.readyState = FakeEventSource.CONNECTING;
    this.dispatchEvent(new Event("error"));
  }
}
