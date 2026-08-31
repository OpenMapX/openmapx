import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  atomicWriteFile,
  atomicWriteFileSync,
  atomicWriteJsonSync,
} from "../../src/utils/atomic-write.js";

const failure = vi.hoisted(() => ({
  at: null as "write" | "file-sync" | "rename" | "directory-sync" | null,
  syncCalls: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync(...args: Parameters<typeof actual.writeFileSync>) {
      if (failure.at === "write") throw new Error("injected write failure");
      return actual.writeFileSync(...args);
    },
    fsyncSync(...args: Parameters<typeof actual.fsyncSync>) {
      failure.syncCalls += 1;
      if (failure.at === "file-sync" && failure.syncCalls === 1) {
        throw new Error("injected file sync failure");
      }
      if (failure.at === "directory-sync" && failure.syncCalls === 2) {
        throw new Error("injected directory sync failure");
      }
      return actual.fsyncSync(...args);
    },
    renameSync(...args: Parameters<typeof actual.renameSync>) {
      if (failure.at === "rename") throw new Error("injected rename failure");
      return actual.renameSync(...args);
    },
  };
});

let directory: string;

beforeEach(() => {
  failure.at = null;
  failure.syncCalls = 0;
  directory = mkdtempSync(join(tmpdir(), "openmapx-atomic-write-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("atomicWriteFileSync", () => {
  it("publishes complete contents without leaving a temporary file", () => {
    const target = join(directory, "state.json");
    writeFileSync(target, "old");

    atomicWriteFileSync(target, "new", { durability: "full" });

    expect(readFileSync(target, "utf8")).toBe("new");
    expect(readdirSync(directory)).toEqual(["state.json"]);
  });

  it.each(["write", "file-sync", "rename"] as const)(
    "preserves the target and cleans up after a %s failure",
    (operation) => {
      const target = join(directory, "state.json");
      writeFileSync(target, "old");
      failure.at = operation;

      expect(() => atomicWriteFileSync(target, "new", { durability: "full" })).toThrow("injected");

      failure.at = null;
      expect(readFileSync(target, "utf8")).toBe("old");
      expect(readdirSync(directory)).toEqual(["state.json"]);
    },
  );

  it("cleans up when directory synchronization fails after publication", () => {
    const target = join(directory, "state.json");
    writeFileSync(target, "old");
    failure.at = "directory-sync";

    expect(() => atomicWriteFileSync(target, "new", { durability: "full" })).toThrow(
      "injected directory sync failure",
    );

    failure.at = null;
    expect(readFileSync(target, "utf8")).toBe("new");
    expect(readdirSync(directory)).toEqual(["state.json"]);
  });
});

describe("atomicWriteFile", () => {
  it("keeps concurrent writers isolated and publishes one complete value", async () => {
    const target = join(directory, "generated.json");
    const values = Array.from({ length: 20 }, (_, index) =>
      JSON.stringify({ writer: index, content: "x".repeat(1_000 + index) }),
    );

    await Promise.all(
      values.map((value) => atomicWriteFile(target, value, { durability: "visibility" })),
    );

    expect(values).toContain(readFileSync(target, "utf8"));
    expect(readdirSync(directory)).toEqual(["generated.json"]);
  });
});

describe("atomicWriteJsonSync", () => {
  it("publishes pretty JSON with a final newline without durability syncs", () => {
    const target = join(directory, "metadata.json");

    atomicWriteJsonSync(
      target,
      { name: "example", enabled: true },
      {
        durability: "visibility",
      },
    );

    expect(readFileSync(target, "utf8")).toBe('{\n  "name": "example",\n  "enabled": true\n}\n');
    expect(failure.syncCalls).toBe(0);
  });

  it("creates the parent directory and applies the requested file mode", () => {
    const target = join(directory, "nested", "private.json");

    atomicWriteJsonSync(
      target,
      { private: true },
      {
        durability: "full",
        createParentDirectory: true,
        mode: 0o600,
      },
    );

    expect(readFileSync(target, "utf8")).toBe('{\n  "private": true\n}\n');
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });
});
