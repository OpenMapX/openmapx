import { describe, expect, it } from "vitest";
import { isLockConflict, retryOnLockTimeout } from "../src/jobs/publish-schema-swap.js";

const retry = { attempts: 3, backoffMs: 1 };

function failingWith(codes: string[]) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    work: async () => {
      const code = codes[calls];
      calls += 1;
      if (code) throw Object.assign(new Error(code), { code });
      return "done";
    },
  };
}

describe("retryOnLockTimeout", () => {
  it("retries lock timeouts and lost deadlocks alike", async () => {
    const run = failingWith(["55P03", "40P01"]);
    await expect(retryOnLockTimeout(retry, run.work)).resolves.toBe("done");
    expect(run.calls).toBe(3);
  });

  it("rethrows the last lock conflict once the attempts are spent", async () => {
    const run = failingWith(["40P01", "40P01", "40P01"]);
    await expect(retryOnLockTimeout(retry, run.work)).rejects.toMatchObject({ code: "40P01" });
    expect(run.calls).toBe(3);
  });

  it("does not retry any other error", async () => {
    const run = failingWith(["42P01"]);
    await expect(retryOnLockTimeout(retry, run.work)).rejects.toMatchObject({ code: "42P01" });
    expect(run.calls).toBe(1);
  });
});

describe("isLockConflict", () => {
  // A drop of retired data that ends on either is still being read and is
  // logged as a warning, not as a failure.
  it("counts lock timeouts and lost deadlocks, and nothing else", () => {
    expect(isLockConflict({ code: "55P03" })).toBe(true);
    expect(isLockConflict({ code: "40P01" })).toBe(true);
    expect(isLockConflict({ code: "42P01" })).toBe(false);
    expect(isLockConflict(new Error("no code"))).toBe(false);
    expect(isLockConflict(null)).toBe(false);
  });
});
