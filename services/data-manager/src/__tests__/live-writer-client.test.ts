import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createLiveTrafficWriter } from "../jobs/traffic/live-writer-client.js";

const temp = mkdtempSync(join(tmpdir(), "openmapx-writer-client-"));
afterEach(() => rmSync(temp, { recursive: true, force: true }));
it("rejects concurrent writes and drains an outstanding write before close", async () => {
  const writer = createLiveTrafficWriter();
  const request = {
    tarPath: join(temp, "missing.tar"),
    statePath: join(temp, "state.json"),
    csv: "",
    waysToEdges: new Map(),
  };
  const pending = writer.write(request);
  const rejected = expect(pending).rejects.toMatchObject({ code: "ENOENT" });
  await expect(writer.write(request)).rejects.toThrow(/busy/);
  await Promise.all([writer.close(), rejected]);
  await expect(writer.write(request)).rejects.toThrow(/closed/);
});
it("rejects pending and future writes when the worker exits without releasing owner state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openmapx-writer-exit-"));
  const entry = join(dir, "exit.mjs");
  writeFileSync(
    entry,
    'import { parentPort } from "node:worker_threads"; parentPort.on("message", () => process.exit(7));',
  );
  const onFailure = vi.fn();
  const writer = createLiveTrafficWriter({ workerUrl: pathToFileURL(entry), onFailure });
  const request = {
    tarPath: join(dir, "missing"),
    statePath: join(dir, "state"),
    csv: "",
    waysToEdges: new Map(),
  };
  try {
    await expect(writer.write(request)).rejects.toThrow(/exited/);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Live traffic writer exited (7)" }),
    );
    await expect(writer.write(request)).rejects.toThrow(/exited/);
  } finally {
    await writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
