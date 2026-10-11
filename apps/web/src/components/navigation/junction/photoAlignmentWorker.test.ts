// @vitest-environment node
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { gunzipSync } from "node:zlib";
import { build } from "esbuild";
import { expect, it } from "vitest";
import fixture from "../../../../../../packages/core/src/navigation/__fixtures__/junction/aachen-two-lane.json";
import type { PhotoAlignmentResponse } from "./photoAlignment.worker";

it("bundles and runs the photo worker without UI runtime dependencies", async () => {
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
        geometry: fixture.geometry,
        point: fixture.point,
        image: fixture.image,
        pixels: { width: fixture.width, height: fixture.height, data },
        exitLanes: { laneCount: 2, activeLanes: [0, 1] },
      },
      [data.buffer],
    );
    const result = await response;
    const path = result.path;
    expect(result.registration.scene).toBe("relevant");
    expect(path.visible).toBe(true);
    expect(path.ribbons).toHaveLength(2);
    expect(path.laneShiftMeters).toBe(0);
  } finally {
    await worker.terminate();
  }
});
