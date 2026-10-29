import * as filesystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tar } from "./__tests__/fixtures/source-tar.js";
import { spoolBackupSourceTar } from "./backup-source-part.js";
import { spoolDawarichTar } from "./dawarich-source-part.js";

// Fail only the marker write, after the real private directory has been created.
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
afterEach(() => vi.mocked(filesystem.writeFile).mockReset());

describe.each([
  ["Dawarich", "dawarich/areas.jsonl", spoolDawarichTar],
  ["backup", "openmapx/account-profile.jsonl", spoolBackupSourceTar],
] as const)("%s spool initialization rollback", (_name, path, spool) => {
  it("removes the private directory and closes the source when marker creation fails", async () => {
    const parent = await filesystem.mkdtemp(join(tmpdir(), "openmapx-marker-failure-"));
    const failure = Object.assign(new Error("synthetic disk full"), { code: "ENOSPC" });
    vi.mocked(filesystem.writeFile).mockRejectedValueOnce(failure);
    let closed = false;
    const source = (async function* () {
      try {
        yield tar([[path, Buffer.from("x")]]);
      } finally {
        closed = true;
      }
    })();
    try {
      await expect(spool(source, { spoolParentDirectory: parent })).rejects.toBe(failure);
      expect(closed).toBe(true);
      expect(await filesystem.readdir(parent)).toEqual([]);
    } finally {
      await filesystem.rm(parent, { recursive: true, force: true });
    }
  });
});
