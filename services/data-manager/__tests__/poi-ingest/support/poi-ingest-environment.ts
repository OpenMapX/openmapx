import type { RegisteredPoiSource } from "@openmapx/poi-source-registry";
import { vi } from "vitest";
import type {
  PoiIngestKind,
  PoiIngestResult,
  PoiIngestStageResult,
} from "../../../src/jobs/poi-ingest/types.js";

type LastFeedState =
  | {
      lastStaticHash: string | null;
      lastStaticRowCount: number | null;
      lastStaticIngestAt: Date | null;
      consecutiveFailures: number;
      status: string;
    }
  | undefined;

const mocks = vi.hoisted(() => {
  const onStageCompleteStub = vi.fn(
    (_result: PoiIngestStageResult): Promise<void> => Promise.resolve(),
  );
  return {
    runStaticIngestMock: vi.fn(
      (_context: unknown): Promise<PoiIngestResult> => Promise.resolve({} as PoiIngestResult),
    ),
    runLiveIngestMock: vi.fn(
      (_context: unknown): Promise<PoiIngestResult> => Promise.resolve({} as PoiIngestResult),
    ),
    runBundledIngestMock: vi.fn(
      (_context: unknown): Promise<PoiIngestResult> => Promise.resolve({} as PoiIngestResult),
    ),
    buildPoiJobContextMock: vi.fn(
      (options: Record<string, unknown>): Record<string, unknown> => ({
        ...options,
        state: {},
      }),
    ),
    createPoiJobRowMock: vi.fn(
      (_options: Record<string, unknown>): Promise<string> => Promise.resolve("job-1"),
    ),
    finalizePoiJobRowMock: vi.fn(
      (_jobId: string, _status: string): Promise<void> => Promise.resolve(),
    ),
    upsertPoiFeedStateMock: vi.fn(
      (_options: Record<string, unknown>): Promise<void> => Promise.resolve(),
    ),
    getLastPoiFeedStateMock: vi.fn(
      (_sourceId: string): Promise<LastFeedState> => Promise.resolve(undefined),
    ),
    onStageCompleteStub,
    makePoiPersistingOnStageCompleteMock: vi.fn(
      (_jobId: string, _logger: unknown) => onStageCompleteStub,
    ),
  };
});

vi.mock("../../../src/jobs/poi-ingest/pipeline.js", () => ({
  runStaticIngest: (...args: unknown[]) => mocks.runStaticIngestMock(...(args as [unknown])),
  runLiveIngest: (...args: unknown[]) => mocks.runLiveIngestMock(...(args as [unknown])),
  runBundledIngest: (...args: unknown[]) => mocks.runBundledIngestMock(...(args as [unknown])),
  buildPoiJobContext: (options: Record<string, unknown>) => mocks.buildPoiJobContextMock(options),
}));

vi.mock("../../../src/jobs/poi-ingest/persistence.js", () => ({
  createPoiJobRow: (...args: unknown[]) =>
    mocks.createPoiJobRowMock(...(args as [Record<string, unknown>])),
  finalizePoiJobRow: (...args: unknown[]) =>
    mocks.finalizePoiJobRowMock(...(args as [string, string])),
  upsertPoiFeedState: (...args: unknown[]) =>
    mocks.upsertPoiFeedStateMock(...(args as [Record<string, unknown>])),
  getLastPoiFeedState: (...args: unknown[]) => mocks.getLastPoiFeedStateMock(...(args as [string])),
  makePoiPersistingOnStageComplete: (...args: unknown[]) =>
    mocks.makePoiPersistingOnStageCompleteMock(...(args as [string, unknown])),
}));

export function getPoiIngestTestMocks() {
  return mocks;
}

export function resetPoiIngestTestMocks(): void {
  mocks.runStaticIngestMock.mockReset();
  mocks.runLiveIngestMock.mockReset();
  mocks.runBundledIngestMock.mockReset();
  mocks.buildPoiJobContextMock.mockReset();
  mocks.createPoiJobRowMock.mockReset();
  mocks.finalizePoiJobRowMock.mockReset();
  mocks.upsertPoiFeedStateMock.mockReset();
  mocks.getLastPoiFeedStateMock.mockReset();
  mocks.onStageCompleteStub.mockReset();
  mocks.makePoiPersistingOnStageCompleteMock.mockReset();

  mocks.buildPoiJobContextMock.mockImplementation((options) => ({ ...options, state: {} }));
  mocks.createPoiJobRowMock.mockResolvedValue("job-1");
  mocks.finalizePoiJobRowMock.mockResolvedValue(undefined);
  mocks.upsertPoiFeedStateMock.mockResolvedValue(undefined);
  mocks.getLastPoiFeedStateMock.mockResolvedValue(undefined);
  mocks.onStageCompleteStub.mockResolvedValue(undefined);
  mocks.makePoiPersistingOnStageCompleteMock.mockImplementation(() => mocks.onStageCompleteStub);
}

export function staticPoiSource(id = "src-1", cron = "0 * * * *"): RegisteredPoiSource {
  return {
    id,
    stationIdPrefix: `${id}:`,
    domain: "ev-charging",
    name: id,
    static: {
      cron,
      fetch: { type: "http", url: "https://example.com/data.csv" },
      parse: function* () {},
    },
  } as RegisteredPoiSource;
}

export function staticLivePoiSource(id = "src-1"): RegisteredPoiSource {
  return {
    id,
    stationIdPrefix: `${id}:`,
    domain: "ev-charging",
    name: id,
    static: {
      cron: "0 * * * *",
      fetch: { type: "http", url: "https://example.com/data.csv" },
      parse: function* () {},
    },
    live: {
      cron: "*/5 * * * *",
      fetch: { type: "http", url: "https://example.com/live.json" },
      parse: () => new Map(),
    },
  } as RegisteredPoiSource;
}

export function bundledPoiSource(id = "bundled-1"): RegisteredPoiSource {
  return {
    id,
    stationIdPrefix: `${id}:`,
    domain: "parking",
    name: id,
    bundled: {
      cron: "*/10 * * * *",
      fetch: { type: "http", url: "https://example.com/feed.json" },
      parse: () => ({ static: [], live: new Map() }),
    },
  } as RegisteredPoiSource;
}

export function fakePoiSql(): import("postgres").Sql {
  return {} as unknown as import("postgres").Sql;
}

export function fakePoiRedis(): import("ioredis").Redis {
  return {} as unknown as import("ioredis").Redis;
}

export function makePoiIngestResult(
  sourceId: string,
  kind: PoiIngestKind,
  overrides: Partial<PoiIngestResult> = {},
): PoiIngestResult {
  return {
    sourceId,
    kind,
    startedAt: "2025-01-01T00:00:00.000Z",
    finishedAt: "2025-01-01T00:00:01.000Z",
    durationMs: 1000,
    status: "ok",
    stages: [],
    ...overrides,
  };
}

resetPoiIngestTestMocks();
