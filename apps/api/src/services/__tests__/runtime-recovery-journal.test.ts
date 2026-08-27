import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  mergeRuntimeRecovery,
  openRuntimeRecoveryJournal,
  type RuntimeRecoveryRecord,
} from "../runtime-recovery-journal.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "openmapx-runtime-recovery-"));
  roots.push(path);
  return path;
}

const record: RuntimeRecoveryRecord = {
  version: 1,
  incidentId: `recovery_${"a".repeat(64)}`,
  orphanedServiceIds: ["community-new"],
  restartServiceIds: ["community-old"],
};

describe("runtime recovery journal", () => {
  it("atomically persists exact remaining work and survives reopen", async () => {
    const path = join(root(), "runtime-recovery", "runtime-recovery-v1.json");
    const journal = await openRuntimeRecoveryJournal(path);
    expect(journal.record()).toBeNull();
    await journal.replace(record);
    expect((await openRuntimeRecoveryJournal(path)).record()).toEqual(record);
    expect(readFileSync(path, "utf8")).not.toContain("docker");
    await journal.replace({ ...record, orphanedServiceIds: [] });
    expect((await openRuntimeRecoveryJournal(path)).record()?.orphanedServiceIds).toEqual([]);
    await journal.clear();
    expect((await openRuntimeRecoveryJournal(path)).record()).toBeNull();
  });

  it("fails closed for malformed, symlinked, hardlinked, and oversized records", async () => {
    const base = root();
    const target = join(base, "target");
    writeFileSync(target, JSON.stringify(record), { mode: 0o600 });
    const invalid: string[] = [];
    for (const name of ["malformed", "symlink", "hardlink", "oversized"]) {
      const directory = join(base, name);
      mkdirSync(directory, { mode: 0o700 });
      invalid.push(join(directory, "runtime-recovery-v1.json"));
    }
    writeFileSync(invalid[0], "not-json", { mode: 0o600 });
    symlinkSync(target, invalid[1]);
    linkSync(target, invalid[2]);
    writeFileSync(invalid[3], "x".repeat(65 * 1024), { mode: 0o600 });
    for (const path of invalid) {
      await expect(openRuntimeRecoveryJournal(path)).rejects.toThrow(
        "Runtime recovery journal is unavailable",
      );
    }
  });

  it("strictly rejects extra fields, duplicate or flag-shaped service IDs, and oversized sets", async () => {
    const path = join(root(), "runtime-recovery", "runtime-recovery-v1.json");
    const journal = await openRuntimeRecoveryJournal(path);
    await expect(journal.replace({ ...record, extra: true } as never)).rejects.toThrow();
    await expect(
      journal.replace({ ...record, orphanedServiceIds: ["community-new", "community-new"] }),
    ).rejects.toThrow();
    await expect(
      journal.replace({ ...record, orphanedServiceIds: ["--project"] }),
    ).rejects.toThrow();
    await expect(
      journal.replace({
        ...record,
        orphanedServiceIds: Array.from({ length: 65 }, (_, index) => `service-${index}`),
      }),
    ).rejects.toThrow();
  });

  it("keeps the first durable incident identity while merging source journals after restart", () => {
    expect(
      mergeRuntimeRecovery(record, {
        version: 1,
        incidentId: `recovery_${"b".repeat(64)}`,
        orphanedServiceIds: ["community-new-2"],
        restartServiceIds: ["community-old"],
      }),
    ).toEqual({
      ...record,
      orphanedServiceIds: ["community-new", "community-new-2"],
      restartServiceIds: ["community-old"],
    });
  });

  it("rejects unsafe ownership/modes and built-in recovery targets", async () => {
    const path = join(root(), "runtime-recovery", "runtime-recovery-v1.json");
    const journal = await openRuntimeRecoveryJournal(path, { forbiddenServiceIds: ["redis"] });
    await expect(journal.replace({ ...record, orphanedServiceIds: ["redis"] })).rejects.toThrow();
    chmodSync(path, 0o640);
    await expect(openRuntimeRecoveryJournal(path)).rejects.toThrow(
      "Runtime recovery journal is unavailable",
    );
    chmodSync(path, 0o600);
    await expect(
      openRuntimeRecoveryJournal(path, { expectedUid: (process.geteuid?.() ?? 0) + 1 }),
    ).rejects.toThrow("Runtime recovery journal is unavailable");
  });

  it("cleans only safe exact crash temporaries and preserves unrelated files", async () => {
    const directory = join(root(), "runtime-recovery");
    const path = join(directory, "runtime-recovery-v1.json");
    await openRuntimeRecoveryJournal(path);
    const temporary = join(directory, `.runtime-recovery-v1.json.${"a".repeat(24)}.tmp`);
    writeFileSync(temporary, readFileSync(path), { mode: 0o600 });
    const unrelated = join(directory, "operator-note.txt");
    writeFileSync(unrelated, "keep", { mode: 0o600 });
    await openRuntimeRecoveryJournal(path);
    expect(() => readFileSync(temporary)).toThrow();
    expect(readFileSync(unrelated, "utf8")).toBe("keep");
  });

  it("fails closed without deleting unsafe or excessive exact crash temporaries", async () => {
    for (const unsafe of ["mode", "symlink", "hardlink", "excess"] as const) {
      const directory = join(root(), "runtime-recovery");
      const path = join(directory, "runtime-recovery-v1.json");
      await openRuntimeRecoveryJournal(path);
      const exact = (index: number) =>
        join(directory, `.runtime-recovery-v1.json.${index.toString(16).padStart(24, "0")}.tmp`);
      if (unsafe === "mode") {
        writeFileSync(exact(1), readFileSync(path), { mode: 0o640 });
      } else if (unsafe === "symlink") {
        symlinkSync(path, exact(1));
      } else if (unsafe === "hardlink") {
        linkSync(path, exact(1));
      } else {
        for (let index = 0; index < 17; index += 1) {
          writeFileSync(exact(index), readFileSync(path), { mode: 0o600 });
        }
      }
      await expect(openRuntimeRecoveryJournal(path)).rejects.toThrow(
        "Runtime recovery journal is unavailable",
      );
      expect(() => readFileSync(exact(unsafe === "excess" ? 0 : 1))).not.toThrow();
    }
  });

  it("rejects a group- or world-accessible dedicated journal directory", async () => {
    const directory = join(root(), "runtime-recovery");
    const path = join(directory, "runtime-recovery-v1.json");
    await openRuntimeRecoveryJournal(path);
    chmodSync(directory, 0o750);
    await expect(openRuntimeRecoveryJournal(path)).rejects.toThrow(
      "Runtime recovery journal is unavailable",
    );
  });
});
