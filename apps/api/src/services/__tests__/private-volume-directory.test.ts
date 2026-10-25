import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Volume roots as Docker seeds them, which a non-root test cannot create.
const seeded = vi.hoisted(() => new Map<string, { uid: number; mode: number }>());
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    lstatSync: ((path: string, ...rest: unknown[]) => {
      const stats = (fs.lstatSync as (...args: unknown[]) => import("node:fs").Stats)(
        path,
        ...rest,
      );
      const override = seeded.get(String(path));
      return override
        ? Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, override)
        : stats;
    }) as typeof fs.lstatSync,
  };
});

const { privateVolumeDirectory } = await import("../private-volume-directory");

const roots: string[] = [];
afterEach(() => {
  seeded.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function mount(): string {
  const root = mkdtempSync(join(tmpdir(), "openmapx-api-volume-"));
  roots.push(root);
  const path = join(root, "volume");
  mkdirSync(path, { mode: 0o700 });
  return path;
}

const uid = process.geteuid?.() ?? 0;

describe("the API's directory in a named volume", () => {
  it("is the root of a volume seeded for this uid, as earlier images did for 1000", () => {
    const path = mount();
    expect(privateVolumeDirectory(path)).toBe(path);
  });

  it("is a per-uid directory in a root-owned sticky volume, as this image seeds", () => {
    const path = mount();
    seeded.set(path, { uid: 0, mode: 0o41777 });
    expect(privateVolumeDirectory(path)).toBe(join(path, `uid-${uid}`));
  });

  it("refuses a volume seeded for another uid, naming the fix", () => {
    const path = mount();
    seeded.set(path, { uid: uid + 1, mode: 0o40700 });
    expect(() => privateVolumeDirectory(path)).toThrow(
      new RegExp(`belongs to uid ${uid + 1} .*not to uid ${uid}.*docker volume rm`),
    );
    // A root-owned volume that is not world-writable and sticky is refused too.
    seeded.set(path, { uid: 0, mode: 0o40755 });
    expect(() => privateVolumeDirectory(path)).toThrow(/belongs to uid 0/);
  });

  it("leaves a missing directory to the store that creates it", () => {
    const path = join(mount(), "absent");
    expect(privateVolumeDirectory(path)).toBe(path);
  });
});
