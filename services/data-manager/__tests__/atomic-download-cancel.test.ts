import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { curlAtomicWithResult } from "../src/jobs/atomic-download.js";

it("contains a real curl transfer before cancellation returns and preserves the prior target", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omx-download-cancel-"));
  const target = join(dir, "snapshot");
  await writeFile(target, "previous");
  const controller = new AbortController();
  let observed = () => {};
  const requestSeen = new Promise<void>((resolve) => {
    observed = resolve;
  });
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = createServer(async (_request, response) => {
    response.write("partial");
    observed();
    await released;
    response.end("complete");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing loopback server");
    const pending = curlAtomicWithResult(`http://127.0.0.1:${address.port}/fixture`, target, {
      signal: controller.signal,
    });
    await requestSeen;
    controller.abort(new Error("execution canceled"));
    release();
    await expect(pending).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("previous");
    expect(await readdir(dir)).toEqual(["snapshot"]);
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
it("rechecks cancellation after validation immediately before publication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omx-download-publish-cancel-"));
  const source = join(dir, "fixture"),
    target = join(dir, "snapshot");
  await writeFile(source, "new");
  await writeFile(target, "previous");
  await utimes(target, new Date(0), new Date(0));
  const controller = new AbortController();
  let validated = false;
  try {
    await expect(
      curlAtomicWithResult(pathToFileURL(source).href, target, {
        signal: controller.signal,
        beforePublish: async () => {
          validated = true;
          controller.abort(new Error("canceled at publication"));
        },
      }),
    ).rejects.toThrow();
    expect(validated).toBe(true);
    expect(await readFile(target, "utf8")).toBe("previous");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
