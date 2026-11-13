import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PrivacyRequestRunner } from "./request-runner.js";

describe("PrivacyRequestRunner", () => {
  it("claims and handles due export work without a release approval or build fingerprint", async () => {
    const task = { id: "t", requestId: "r", status: "pending" as const, attempts: 0 };
    const store = {
      claimDueTask: vi.fn(async () => task),
      completeTask: vi.fn(async () => {}),
      retryTask: vi.fn(async () => {}),
      operatorReview: vi.fn(async () => {}),
    };
    const handler = vi.fn(async () => {});
    const runner = new PrivacyRequestRunner(store, handler);

    expect(await runner.runOnce()).toBe(true);
    expect(handler).toHaveBeenCalledExactlyOnceWith(task);
    expect(store.completeTask).toHaveBeenCalledExactlyOnceWith("t");
  });

  it("does not handle or settle work when the store has no due task", async () => {
    const now = new Date("2026-09-05T12:00:00Z");
    const store = {
      claimDueTask: vi.fn(async () => null),
      completeTask: vi.fn(async () => {}),
      retryTask: vi.fn(async () => {}),
      operatorReview: vi.fn(async () => {}),
    };
    const handler = vi.fn(async () => {});
    const runner = new PrivacyRequestRunner(store, handler, { now: () => now });

    expect(await runner.runOnce()).toBe(false);
    expect(store.claimDueTask).toHaveBeenCalledExactlyOnceWith(now);
    expect(handler).not.toHaveBeenCalled();
    expect(store.completeTask).not.toHaveBeenCalled();
    expect(store.retryTask).not.toHaveBeenCalled();
    expect(store.operatorReview).not.toHaveBeenCalled();
  });

  it("retries transient failures and then requires operator review", async () => {
    const now = new Date("2026-09-05T12:00:00Z");
    const task = { id: "t", requestId: "r", status: "running" as const };
    const store = {
      claimDueTask: vi
        .fn()
        .mockResolvedValueOnce({ ...task, attempts: 2 })
        .mockResolvedValueOnce({ ...task, attempts: 3 }),
      completeTask: vi.fn(async () => {}),
      retryTask: vi.fn(async () => {}),
      operatorReview: vi.fn(async () => {}),
    };
    const runner = new PrivacyRequestRunner(
      store,
      async () => {
        throw new Error("temporary");
      },
      { maxAttempts: 3, retryDelayMs: 1000, now: () => now },
    );

    await runner.runOnce();
    expect(store.retryTask).toHaveBeenCalledExactlyOnceWith(
      "t",
      new Date("2026-09-05T12:00:02Z"),
      "collector-transient",
    );
    expect(store.operatorReview).not.toHaveBeenCalled();

    await runner.runOnce();
    expect(store.operatorReview).toHaveBeenCalledExactlyOnceWith("t", "collector-exhausted");
    expect(store.retryTask).toHaveBeenCalledTimes(1);
    expect(store.completeTask).not.toHaveBeenCalled();
  });
});

describe("privacy export availability inputs", () => {
  // A dependency bump changes pnpm-lock.yaml. Export availability must never
  // depend on that file or on a build fingerprint derived from source files.
  it("never reads the lockfile or a build fingerprint", () => {
    const apiRoot = resolve(import.meta.dirname, "../..");
    const runtimeFiles = [
      join(apiRoot, "esbuild.config.mjs"),
      join(apiRoot, "src/app.ts"),
      join(apiRoot, "src/routes/privacy-admin.ts"),
      join(apiRoot, "src/routes/privacy-requests.ts"),
      ...readdirSync(join(apiRoot, "src/privacy"), { recursive: true, encoding: "utf8" })
        .filter((path) => /\.ts$/.test(path) && !/\.test\.ts$/.test(path))
        .map((path) => join(apiRoot, "src/privacy", path)),
    ];
    for (const file of runtimeFiles) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/pnpm-lock|SOURCE_FINGERPRINT|sourceBuildFingerprint/);
    }
  });
});
