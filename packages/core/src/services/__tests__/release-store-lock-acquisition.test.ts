import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { acquireReleaseStoreLock, RELEASE_STORE_LOCK_NAME } from "../release-store-lock";

const fault = vi.hoisted(() => ({ path: "", beforeFault: undefined as (() => void) | undefined }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
      if (String(args[0]) === fault.path) {
        fault.path = "";
        fault.beforeFault?.();
        throw Object.assign(Error("Synthetic observation failure"), { code: "EIO" });
      }
      return fs.lstatSync(...args);
    },
  };
});
let root = "";
afterEach(() => {
  fault.path = "";
  fault.beforeFault = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
});
it("releases a physical lock when post-acquisition observation fails before exposing a holder", async () => {
  root = mkdtempSync(join(tmpdir(), "openmapx-lock-acquisition-"));
  fault.path = join(root, RELEASE_STORE_LOCK_NAME);
  await expect(acquireReleaseStoreLock(root)).rejects.toThrow("Synthetic observation failure");
  expect(existsSync(join(root, RELEASE_STORE_LOCK_NAME))).toBe(false);
  const next = await acquireReleaseStoreLock(root, {}, { failIfBusy: true });
  next.release();
});

it("does not delete a successor while cleaning a failed acquisition observation", async () => {
  root = mkdtempSync(join(tmpdir(), "openmapx-lock-acquisition-"));
  const path = join(root, RELEASE_STORE_LOCK_NAME);
  fault.path = path;
  const successor = JSON.stringify({
    pid: process.pid,
    nonce: "successor",
    acquiredAtMs: Date.now(),
    leaseMs: 900000,
  });
  fault.beforeFault = () => {
    renameSync(path, `${path}-original`);
    mkdirSync(path);
    writeFileSync(join(path, "owner.json"), successor, { mode: 0o600 });
  };
  await expect(acquireReleaseStoreLock(root)).rejects.toThrow("Synthetic observation failure");
  expect(readFileSync(join(path, "owner.json"), "utf8")).toBe(successor);
});
