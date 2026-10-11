import type { GantryModel, JunctionDecisionPoint, StreetLevelImage } from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PhotoAlignmentRequest,
  PhotoAlignmentResponse,
} from "@/components/navigation/junction/photoAlignment.worker";
import { photoPreparationKey, prepareJunctionPhoto } from "./prepareJunctionPhoto";

const point: JunctionDecisionPoint = {
  stepIndex: 1,
  kind: "exit",
  side: "left",
  point: [1, 51],
  alongMeters: 100,
  approachBearing: 90,
  divergenceDeg: -20,
  activeLanes: [0, 1],
};
const image: StreetLevelImage = {
  id: "test",
  providerId: "panoramax",
  lngLat: [0.999, 51],
  heading: 90,
  isPano: false,
  fovDeg: 90,
  assets: {},
};
const response: PhotoAlignmentResponse = {
  registration: {
    version: "observed-boundaries-v2",
    scene: "relevant",
    alignment: null,
    evidence: { roadFraction: 0.7, markingFraction: 0.02, observedBoundaries: 0 },
  },
  path: { points: [], visible: false, laneShiftMeters: 0, headRotateDeg: 0 },
};
const decode = vi.fn();
class DecodedImage {
  naturalWidth = 1200;
  naturalHeight = 2400;
  src = "";
  decode = decode;
}
class TestWorker {
  static jobs: TestWorker[] = [];
  onmessage?: (event: MessageEvent<PhotoAlignmentResponse>) => void;
  onerror?: () => void;
  terminate = vi.fn();
  request?: PhotoAlignmentRequest;
  constructor() {
    TestWorker.jobs.push(this);
  }
  postMessage(request: PhotoAlignmentRequest) {
    this.request = request;
  }
  finish(data = response) {
    this.onmessage?.({ data } as MessageEvent<PhotoAlignmentResponse>);
  }
}
beforeEach(() => {
  decode.mockReset().mockResolvedValue(undefined);
  TestWorker.jobs = [];
  vi.stubGlobal("Image", DecodedImage);
  vi.stubGlobal("Worker", TestWorker);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    return {
      drawImage: vi.fn(),
      getImageData: () => ({
        width: this.width,
        height: this.height,
        data: new Uint8ClampedArray(this.width * this.height * 4),
      }),
    } as unknown as CanvasRenderingContext2D;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const begin = (signal = new AbortController().signal, source = image) =>
  prepareJunctionPhoto(
    "blob:test",
    [
      [0.99, 51],
      [1, 51],
    ],
    point,
    source,
    undefined,
    "test-key",
    signal,
  );
const decoded = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
describe("offscreen photo preparation", () => {
  it("waits for registration and bounds both canvas dimensions", async () => {
    const promise = begin();
    await decoded();
    const worker = TestWorker.jobs[0];
    expect(worker.request?.pixels.width).toBe(512);
    expect(worker.request?.pixels.height).toBe(1024);
    worker.finish();
    const result = await promise;
    expect(result?.key).toBe("test-key");
    expect(result?.aspectRatio).toBe(0.5);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  it("drops decode failure without allocating a worker", async () => {
    decode.mockRejectedValue(new Error("bad image"));
    expect(await begin()).toBeNull();
    expect(TestWorker.jobs).toHaveLength(0);
  });
  it("rejects a thumbnail incorrectly labeled a full panorama", async () => {
    expect(await begin(undefined, { ...image, isPano: true })).toBeNull();
    expect(TestWorker.jobs).toHaveLength(0);
  });
  it("drops a rejected scene and terminates its worker", async () => {
    const promise = begin();
    await decoded();
    TestWorker.jobs[0].finish({
      ...response,
      registration: { ...response.registration, scene: "rejected", reason: "unclear-scene" },
    });
    expect(await promise).toBeNull();
    expect(TestWorker.jobs[0].terminate).toHaveBeenCalledTimes(1);
  });
  it("cancels a superseded fit and ignores its late response", async () => {
    const controller = new AbortController();
    const promise = begin(controller.signal);
    await decoded();
    controller.abort();
    TestWorker.jobs[0].finish();
    expect(await promise).toBeNull();
    expect(TestWorker.jobs[0].terminate).toHaveBeenCalledTimes(1);
  });
  it("times out a worker without leaving a blank pending photo", async () => {
    vi.useFakeTimers();
    const promise = begin();
    await decoded();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await promise).toBeNull();
    expect(TestWorker.jobs[0].terminate).toHaveBeenCalledTimes(1);
  });
  it("bounds a decode promise that never settles", async () => {
    vi.useFakeTimers();
    decode.mockImplementation(() => new Promise(() => {}));
    const promise = begin();
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(5001);
    expect(settled).toBe(true);
    expect(await promise).toBeNull();
    expect(TestWorker.jobs).toHaveLength(0);
  });
  it("includes route generation and preferred-lane layout in the preparation identity", () => {
    const model = {
      laneCount: 3,
      laneGuidance: { lanes: [], usableLanes: [0, 1], preferredLanes: [0], state: "known" },
    } as unknown as GantryModel;
    const a = photoPreparationKey(1, point, image, model);
    expect(photoPreparationKey(2, point, image, model)).not.toBe(a);
    expect(
      photoPreparationKey(1, point, image, {
        ...model,
        laneGuidance: { ...model.laneGuidance!, preferredLanes: [1] },
      }),
    ).not.toBe(a);
  });
});
