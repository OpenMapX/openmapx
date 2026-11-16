import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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
it("starts every download with connect-timeout and low-speed abort, but no overall time limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omx-download-stall-flags-"));
  const bin = join(dir, "bin");
  const argsFile = join(dir, "args.txt");
  await mkdir(bin);
  await writeFile(join(bin, "curl"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\nexit 7\n`, {
    mode: 0o755,
  });
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
  try {
    await expect(
      curlAtomicWithResult("http://127.0.0.1:9/fixture", join(dir, "snapshot")),
    ).rejects.toThrow();
    const args = (await readFile(argsFile, "utf8")).trim().split("\n");
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    expect(after("--connect-timeout")).toBe("30");
    expect(after("--speed-limit")).toBe("1024");
    expect(after("--speed-time")).toBe("300");
    expect(args).not.toContain("--max-time");
    expect(args).not.toContain("-m");
    expect(await readdir(dir)).toEqual(
      expect.not.arrayContaining([expect.stringMatching(/^snapshot\.tmp\./)]),
    );
  } finally {
    process.env.PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  }
});
