// @vitest-environment node
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { gunzipSync } from "node:zlib";
import { build } from "esbuild";
import { expect, it } from "vitest";
import fixture from "../../../../../../packages/core/src/navigation/__fixtures__/junction/aachen-two-lane.json";
import type { PhotoAlignmentRequest, PhotoAlignmentResponse } from "./photoAlignment.worker";

const calibration = fixture as unknown as Pick<
  PhotoAlignmentRequest,
  "geometry" | "point" | "image"
> & {
  width: number;
  height: number;
};
const bundledScript = (async () => {
  const built = await build({
    entryPoints: [new URL("./photoAlignment.worker.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    metafile: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
  });
  const script = built.outputFiles[0].text;
  expect(Buffer.byteLength(script)).toBeLessThan(128_000);
  expect(
    Object.keys(built.metafile.inputs).some((path) => /node_modules\/.*react/.test(path)),
  ).toBe(false);
  return script;
})();

async function runWorker(
  request: Omit<PhotoAlignmentRequest, "pixels">,
): Promise<PhotoAlignmentResponse> {
  const script = await bundledScript;
  const bootstrap = `const {parentPort} = require('node:worker_threads');globalThis.self={postMessage:data=>parentPort.postMessage(data)};${script};parentPort.on('message',data=>self.onmessage({data}));`;
  const worker = new Worker(bootstrap, { eval: true });
  try {
    const response = new Promise<PhotoAlignmentResponse>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    const data = new Uint8ClampedArray(
      gunzipSync(
        readFileSync(
          new URL(
            "../../../../../../packages/core/src/navigation/__fixtures__/junction/aachen-two-lane.rgba.gz",
            import.meta.url,
          ),
        ),
      ),
    );
    worker.postMessage(
      {
        ...request,
        pixels: { width: calibration.width, height: calibration.height, data },
      },
      [data.buffer],
    );
    return await response;
  } finally {
    await worker.terminate();
  }
}

it("bundles and runs the photo worker without UI runtime dependencies", async () => {
  const result = await runWorker({
    geometry: calibration.geometry,
    point: calibration.point,
    image: calibration.image,
    exitLanes: { laneCount: 2, activeLanes: [0, 1] },
  });
  expect(result.registration.scene).toBe("relevant");
  expect(result.path.visible).toBe(true);
  expect(result.path.ribbons).toHaveLength(2);
  expect(result.path.laneShiftMeters).toBe(0);
});

it.each([2, 3])(
  "checks physical layout count %s without permission to draw preferred lanes",
  async (laneCount) => {
    const result = await runWorker({
      geometry: calibration.geometry,
      point: { ...calibration.point, laneCount, activeLanes: [] },
      image: calibration.image,
      layoutLaneCount: laneCount,
      approachWay: {
        wayId: 1,
        highway: "motorway",
        bearing: 84,
        startDistanceMeters: 300,
        endDistanceMeters: 0,
        tags: { lanes: 2 },
      },
    });
    expect(result.registration.scene).toBe(laneCount === 2 ? "relevant" : "rejected");
    if (laneCount === 3) expect(result.registration.reason).toBe("layout-mismatch");
    expect(result.path.visible).toBe(false);
    expect(result.path.points).toEqual([]);
    expect(result.path.ribbons).toEqual([]);
  },
);
