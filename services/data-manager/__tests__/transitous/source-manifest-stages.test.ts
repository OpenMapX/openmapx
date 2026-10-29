import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fetchStage from "../../src/jobs/transitous/fetch.js";
import * as fetchOperatorStage from "../../src/jobs/transitous/fetch-operator.js";
import { runFetchPipeline } from "../../src/jobs/transitous/internal.js";
import { buildJobContext } from "../../src/jobs/transitous/pipeline.js";
import { finalizeTransitSourceManifest } from "../../src/jobs/transitous/source-manifest.js";
import type { FeedFileEntry, JobContext, StageResult } from "../../src/jobs/transitous/types.js";
import { StateStore } from "../../src/state.js";

// Only the acquisition, database and finalizer boundaries are replaced; the
// stages themselves run unmodified so their handling of the finalizer's
// completion and failure is what is under test.
vi.mock("../../src/jobs/transitous/source-manifest.js", () => ({
  finalizeTransitSourceManifest: vi.fn(),
}));
vi.mock("../../src/jobs/transitous/internal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/jobs/transitous/internal.js")>();
  return {
    ...actual,
    scanGtfsArchives: vi.fn(() => []),
    runFetchPipeline: vi.fn(async () => []),
  };
});
vi.mock("../../src/jobs/transitous/feed-state-writer.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/jobs/transitous/feed-state-writer.js")>();
  return { ...actual, recordFetchOutcome: vi.fn(async () => undefined) };
});

interface Deferred {
  promise: Promise<string>;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

function deferred(): Deferred {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every already-resolved promise and mocked I/O boundary settle. */
async function settleBoundaries(): Promise<void> {
  for (let index = 0; index < 5; index++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function observe(promise: Promise<StageResult>): { settled: () => boolean } {
  let done = false;
  void promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  return { settled: () => done };
}

function feedWith(origin: "catalog" | "operator"): FeedFileEntry {
  return {
    id: "de",
    country: "de",
    path: "feeds/de.json",
    url: "catalog",
    activeScheduleSources: [
      {
        id: "de_bvg",
        sourceId: `${origin}:de:bvg`,
        region: "de",
        name: "bvg",
        format: "gtfs",
        origin,
        ...(origin === "operator" ? { originUrl: "https://operator.example/gtfs" } : {}),
      },
    ],
  };
}

let tmp: string;
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

function makeCtx(feeds: FeedFileEntry[]): JobContext {
  const ctx = buildJobContext({ dataDir: tmp, store: new StateStore(tmp) });
  ctx.state.selectedFeedFiles = feeds;
  ctx.state.selectedCount = feeds.flatMap((feed) => feed.activeScheduleSources).length;
  return ctx;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-manifest-stages-"));
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
  vi.mocked(finalizeTransitSourceManifest).mockReset();
  vi.mocked(runFetchPipeline).mockReset();
  vi.mocked(runFetchPipeline).mockResolvedValue([]);
});

afterEach(async () => {
  await settleBoundaries();
  process.off("unhandledRejection", onUnhandled);
  expect(unhandled).toEqual([]);
  rmSync(tmp, { recursive: true, force: true });
});

describe("fetch stage manifest finalization", () => {
  it("stays pending until the finalizer succeeds", async () => {
    const finalizer = deferred();
    vi.mocked(finalizeTransitSourceManifest).mockReturnValue(finalizer.promise as never);
    const pending = fetchStage.run(makeCtx([feedWith("catalog")]));
    const state = observe(pending);

    await settleBoundaries();
    expect(finalizeTransitSourceManifest).toHaveBeenCalledTimes(1);
    expect(state.settled()).toBe(false);

    finalizer.resolve("manifest.json");
    const result = await pending;
    expect(result.status).toBe("ok");
    expect(result.stage).toBe("fetch");
  });

  it("turns a delayed finalizer rejection into the stage error result", async () => {
    const finalizer = deferred();
    vi.mocked(finalizeTransitSourceManifest).mockReturnValue(finalizer.promise as never);
    const pending = fetchStage.run(makeCtx([feedWith("catalog")]));
    const state = observe(pending);

    await settleBoundaries();
    expect(state.settled()).toBe(false);

    finalizer.reject(new Error("manifest hashing failed"));
    const result = await pending;
    expect(result.status).toBe("error");
    expect(result.message).toBe("manifest hashing failed");
    expect(result.error?.message).toBe("manifest hashing failed");
  });

  it("does not finalize when the fetch reports failures", async () => {
    vi.mocked(runFetchPipeline).mockResolvedValue([
      { id: "de_bvg", country: "de", url: "catalog", message: "download failed" },
    ]);

    const result = await fetchStage.run(makeCtx([feedWith("catalog")]));

    expect(result.status).toBe("error");
    expect(finalizeTransitSourceManifest).not.toHaveBeenCalled();
  });
});

describe("fetch-operator stage manifest finalization", () => {
  it("stays pending until the finalizer succeeds", async () => {
    const finalizer = deferred();
    vi.mocked(finalizeTransitSourceManifest).mockReturnValue(finalizer.promise as never);
    const pending = fetchOperatorStage.run(makeCtx([feedWith("operator")]));
    const state = observe(pending);

    await settleBoundaries();
    expect(finalizeTransitSourceManifest).toHaveBeenCalledTimes(1);
    expect(state.settled()).toBe(false);

    finalizer.resolve("manifest.json");
    const result = await pending;
    expect(result.status).toBe("ok");
    expect(result.stage).toBe("fetch-operator");
  });

  it("turns a delayed finalizer rejection into the stage error result", async () => {
    const finalizer = deferred();
    vi.mocked(finalizeTransitSourceManifest).mockReturnValue(finalizer.promise as never);
    const pending = fetchOperatorStage.run(makeCtx([feedWith("operator")]));
    const state = observe(pending);

    await settleBoundaries();
    expect(state.settled()).toBe(false);

    finalizer.reject(new Error("manifest hashing failed"));
    const result = await pending;
    expect(result.status).toBe("error");
    expect(result.message).toBe("manifest hashing failed");
  });

  it("finalizes before reporting skipped when there are no operator feeds", async () => {
    const finalizer = deferred();
    vi.mocked(finalizeTransitSourceManifest).mockReturnValue(finalizer.promise as never);
    const pending = fetchOperatorStage.run(makeCtx([feedWith("catalog")]));
    const state = observe(pending);

    await settleBoundaries();
    expect(finalizeTransitSourceManifest).toHaveBeenCalledTimes(1);
    expect(runFetchPipeline).not.toHaveBeenCalled();
    expect(state.settled()).toBe(false);

    finalizer.resolve("manifest.json");
    const result = await pending;
    expect(result.status).toBe("skipped");
    expect(result.message).toBe("No operator transit sources configured");
  });

  it("reports an error instead of skipped when zero-feed finalization fails", async () => {
    const finalizer = deferred();
    vi.mocked(finalizeTransitSourceManifest).mockReturnValue(finalizer.promise as never);
    const pending = fetchOperatorStage.run(makeCtx([feedWith("catalog")]));

    await settleBoundaries();
    finalizer.reject(new Error("manifest incomplete"));

    const result = await pending;
    expect(result.status).toBe("error");
    expect(result.message).toBe("manifest incomplete");
  });

  it("does not finalize when an acquisition failure was recorded", async () => {
    vi.mocked(runFetchPipeline).mockResolvedValue([
      { id: "de_bvg", country: "de", url: "https://operator.example/gtfs", message: "boom" },
    ]);

    const result = await fetchOperatorStage.run(makeCtx([feedWith("operator")]));

    expect(result.status).toBe("error");
    expect(finalizeTransitSourceManifest).not.toHaveBeenCalled();
  });
});
