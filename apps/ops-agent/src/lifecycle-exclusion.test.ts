import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { afterEach, expect, it } from "vitest";
import { ServiceLifecycleExclusion } from "./lifecycle-exclusion";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const infra = mkdtempSync(join(tmpdir(), "ops-lifecycle-state-"));
  roots.push(infra);
  const state = services.agentStatePaths(infra).directory;
  mkdirSync(state, { recursive: true, mode: 0o700 });
  return { infra, state };
}
it("retains an unresolved lifecycle fence through restart below writable state while infrastructure is read-only", async () => {
  const { infra, state } = fixture();
  chmodSync(infra, 0o555);
  const lifecycle = new ServiceLifecycleExclusion(infra);
  await expect(
    lifecycle.creating(["alpha"], new AbortController().signal, async (begin) => {
      begin();
      throw Error("unknown external completion");
    }),
  ).rejects.toThrow("unknown external completion");
  const pending = join(state, "service-lifecycle/pending.json");
  expect(readFileSync(pending, "utf8")).toBe('["alpha"]');
  expect(statSync(pending).mode & 0o777).toBe(0o600);
  expect(existsSync(join(infra, ".service-lifecycle"))).toBe(false);
  const restored = new ServiceLifecycleExclusion(infra);
  await expect(
    restored.run(["alpha"], new AbortController().signal, async () => "effect"),
  ).rejects.toThrow("settlement is unresolved");
  await expect(
    restored.run(["beta"], new AbortController().signal, async () => "unrelated"),
  ).resolves.toBe("unrelated");
  chmodSync(pending, 0o644);
  expect(() => new ServiceLifecycleExclusion(infra)).toThrow("settlement is unresolved");
});
it("refuses legacy lifecycle state intact instead of resetting an older unresolved fence", () => {
  const { infra } = fixture();
  const legacy = join(infra, ".service-lifecycle");
  mkdirSync(legacy, { mode: 0o700 });
  const pending = join(legacy, "pending.json");
  writeFileSync(pending, '["alpha"]', { mode: 0o600 });
  const before = statSync(pending);
  expect(() => new ServiceLifecycleExclusion(infra)).toThrow("settlement is unresolved");
  expect(readFileSync(pending, "utf8")).toBe('["alpha"]');
  expect(statSync(pending).ino).toBe(before.ino);
});
