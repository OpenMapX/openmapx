import { fstatSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readAuditInput } from "./read-input.ts";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, fstatSync: vi.fn(actual.fstatSync) };
});
let dir: string | undefined;
afterEach(() => {
  vi.mocked(fstatSync).mockReset();
  if (dir) rmSync(dir, { recursive: true, force: true });
});
it("caps actual bytes even when descriptor metadata predates file growth", () => {
  dir = mkdtempSync(join(tmpdir(), "omx-camera-growth-test-"));
  const path = join(dir, "input.json");
  writeFileSync(path, Buffer.alloc(5242881));
  const oldStat = statSync(path);
  oldStat.size = 0;
  vi.mocked(fstatSync).mockReturnValue(oldStat);
  expect(() => readAuditInput(path)).toThrow("Input size exceeds 5 MiB");
});
it("accepts exactly capped bytes without dropping the last byte", () => {
  dir = mkdtempSync(join(tmpdir(), "omx-camera-cap-test-"));
  const path = join(dir, "input.json");
  const input = Buffer.alloc(5242880, 65);
  writeFileSync(path, input);
  vi.mocked(fstatSync).mockReturnValue(statSync(path));
  const actual = readAuditInput(path);
  expect(actual.byteLength).toBe(5242880);
  expect(actual.equals(input)).toBe(true);
});
