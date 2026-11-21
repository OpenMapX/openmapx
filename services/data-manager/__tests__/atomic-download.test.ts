import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { curlAtomicWithResult } from "../src/jobs/atomic-download.js";
import { serve, withLoopbackServer } from "./helpers/loopback-server.js";

let dir: string;
let target: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omx-atomic-download-"));
  target = join(dir, "snapshot");
  await writeFile(target, "previous");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The directory holds the target alone: no `.tmp.*` sibling was left behind. */
async function onlyTarget() {
  expect(await readdir(dir)).toEqual(["snapshot"]);
}

it("publishes the new bytes inside the publication lock", async () => {
  let beforeRename = "";
  let afterRename = "";
  const result = await withLoopbackServer(serve("new bytes"), (url) =>
    curlAtomicWithResult(url, target, {
      withPublishLock: async (publish) => {
        beforeRename = await readFile(target, "utf8");
        publish();
        afterRename = await readFile(target, "utf8");
      },
    }),
  );
  expect(result).toEqual({ published: true });
  expect([beforeRename, afterRename]).toEqual(["previous", "new bytes"]);
  await onlyTarget();
});

it("keeps the existing target when the server answers 304 Not Modified", async () => {
  let conditional = false;
  let locked = false;
  const result = await withLoopbackServer(
    (request, response) => {
      conditional = request.headers["if-modified-since"] !== undefined;
      serve("new bytes", { notModified: true })(request, response);
    },
    (url) =>
      curlAtomicWithResult(url, target, {
        withPublishLock: async (publish) => {
          locked = true;
          publish();
        },
      }),
  );
  expect(conditional).toBe(true);
  expect(result).toEqual({ published: false });
  expect(locked).toBe(false);
  expect(await readFile(target, "utf8")).toBe("previous");
  await onlyTarget();
});

it("keeps the previous bytes and no temp file when validation refuses the download", async () => {
  let validated = "";
  await expect(
    withLoopbackServer(serve("new bytes"), (url) =>
      curlAtomicWithResult(url, target, {
        beforePublish: async (tempPath) => {
          validated = await readFile(tempPath, "utf8");
          throw new Error("checksum mismatch");
        },
      }),
    ),
  ).rejects.toThrow("checksum mismatch");
  expect(validated).toBe("new bytes");
  expect(await readFile(target, "utf8")).toBe("previous");
  await onlyTarget();
});

it("keeps the previous bytes and no temp file when the publication lock fails", async () => {
  await expect(
    withLoopbackServer(serve("new bytes"), (url) =>
      curlAtomicWithResult(url, target, {
        withPublishLock: async () => {
          throw new Error("publication lock busy");
        },
      }),
    ),
  ).rejects.toThrow("publication lock busy");
  expect(await readFile(target, "utf8")).toBe("previous");
  await onlyTarget();
});

it("refuses a publication lock that resolves without publishing", async () => {
  await expect(
    withLoopbackServer(serve("new bytes"), (url) =>
      curlAtomicWithResult(url, target, { withPublishLock: async () => {} }),
    ),
  ).rejects.toThrow(/resolved without publishing/);
  expect(await readFile(target, "utf8")).toBe("previous");
  await onlyTarget();
});
