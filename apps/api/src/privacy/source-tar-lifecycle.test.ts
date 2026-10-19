import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { tar } from "./__tests__/fixtures/source-tar.js";
import { spoolBackupSourceTar } from "./backup-source-part.js";
import { spoolDawarichTar } from "./dawarich-source-part.js";

describe.each([
  ["Dawarich", "dawarich/areas.jsonl", spoolDawarichTar],
  ["backup", "openmapx/account-profile.jsonl", spoolBackupSourceTar],
] as const)("%s source stream lifecycle", (_name, path, spool) => {
  it("closes upstream when encrypted spool initialization fails", async () => {
    const parent = await mkdtemp(join(tmpdir(), "openmapx-source-init-"));
    const blocked = join(parent, "file");
    let closed = false;
    let pulledBody = false;
    await writeFile(blocked, "not a directory");
    const source = (async function* () {
      try {
        const input = tar([[path, Buffer.from("x")]]);
        yield input.subarray(0, 512);
        pulledBody = true;
        yield input.subarray(512);
      } finally {
        closed = true;
      }
    })();
    try {
      await expect(spool(source, { spoolParentDirectory: blocked })).rejects.toMatchObject({
        code: "EEXIST",
      });
      expect(closed).toBe(true);
      expect(pulledBody).toBe(false);
      expect(await readdir(parent)).toEqual(["file"]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("removes encrypted members and closes upstream on a late framing failure", async () => {
    const parent = await mkdtemp(join(tmpdir(), "openmapx-source-failed-"));
    let closed = false;
    const source = (async function* () {
      try {
        yield tar([[path, Buffer.from("x")]]);
        yield Buffer.from("trailer");
      } finally {
        closed = true;
      }
    })();
    try {
      await expect(spool(source, { spoolParentDirectory: parent })).rejects.toMatchObject({
        code: "trailing_data",
      });
      expect(closed).toBe(true);
      expect(await readdir(parent)).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("removes partially written ciphertext when upstream fails", async () => {
    const parent = await mkdtemp(join(tmpdir(), "openmapx-source-interrupted-"));
    const original = new Error("source interrupted");
    const source = (async function* () {
      yield tar([[path, Buffer.alloc(32768)]]).subarray(0, 1024);
      throw original;
    })();
    try {
      await expect(spool(source, { spoolParentDirectory: parent })).rejects.toBe(original);
      expect(await readdir(parent)).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

it("destroys an unstarted Node source when the backup namespace is invalid", async () => {
  const input = Readable.from([tar([["openmapx/account-profile.jsonl", Buffer.from("x")]])]);
  await expect(spoolBackupSourceTar(input, { namespace: "invalid" })).rejects.toMatchObject({
    code: "manifest_mismatch",
  });
  expect(input.destroyed).toBe(true);
});
