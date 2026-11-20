import { classifyProviderFailure, ProviderTimeoutError } from "@openmapx/integration-framework";
import { describe, expect, it, vi } from "vitest";
import { createIntegrationDb } from "../integration-db";

/** A postgres.js-shaped client whose statement settles as `settle` decides. */
function client(settle: () => Promise<unknown>) {
  const cancel = vi.fn();
  const unsafe = vi.fn(() => Object.assign(settle(), { cancel }));
  return { client: { unsafe } as never, unsafe, cancel };
}

describe("integration ctx.db", () => {
  it("rejects a statement the server timed out as a provider timeout", async () => {
    const canceled = Object.assign(new Error("canceling statement due to statement timeout"), {
      code: "57014",
    });
    const { client: db } = client(() => Promise.reject(canceled));

    const failure = createIntegrationDb(db).execute("select pg_sleep(6)");

    await expect(failure).rejects.toBeInstanceOf(ProviderTimeoutError);
    await expect(failure).rejects.toMatchObject({ cause: canceled });
    expect(classifyProviderFailure(await failure.catch((error) => error))).toBe("timeout");
  });

  it("keeps the caller's cancellation and other database errors as they are", async () => {
    const canceled = Object.assign(new Error("canceling statement due to user request"), {
      code: "57014",
    });
    const controller = new AbortController();
    let reject!: (error: unknown) => void;
    const { client: db, cancel } = client(
      () =>
        new Promise((_resolve, rejectStatement) => {
          reject = rejectStatement;
        }),
    );
    const pending = createIntegrationDb(db).execute("select 1", [], { signal: controller.signal });
    controller.abort();
    expect(cancel).toHaveBeenCalledOnce();
    reject(canceled);
    await expect(pending).rejects.toBe(canceled);

    const missing = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    const { client: broken } = client(() => Promise.reject(missing));
    await expect(createIntegrationDb(broken).execute("select 1")).rejects.toBe(missing);
  });
});
