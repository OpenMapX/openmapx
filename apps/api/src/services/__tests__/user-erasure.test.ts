import { describe, expect, it, vi } from "vitest";
import { createUserErasureHooks } from "../user-erasure";

describe("user erasure hooks", () => {
  it("durably records the request before cleaning residual records and records completion", async () => {
    const events: string[] = [];
    const hooks = createUserErasureHooks({
      request: vi.fn(async () => {
        events.push("requested");
        return "receipt-1";
      }),
      cleanup: vi.fn(async () => {
        events.push("cleaned");
      }),
      complete: vi.fn(async () => {
        events.push("completed");
      }),
    });
    const user = { id: "user-1", email: "person@example.test" };

    await hooks.before(user);
    await hooks.after(user);

    expect(events).toEqual(["requested", "cleaned", "completed"]);
  });

  it("fails closed without cleaning data when the durable request cannot be written", async () => {
    const cleanup = vi.fn();
    const hooks = createUserErasureHooks({
      request: async () => {
        throw new Error("journal unavailable");
      },
      cleanup,
      complete: vi.fn(),
    });

    await expect(hooks.before({ id: "user-1", email: "person@example.test" })).rejects.toThrow(
      "journal unavailable",
    );
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("does not complete a request when pre-delete cleanup aborts deletion", async () => {
    const complete = vi.fn();
    const hooks = createUserErasureHooks({
      request: async () => "receipt-1",
      cleanup: async () => {
        throw new Error("cleanup failed");
      },
      complete,
    });
    const user = { id: "user-1", email: "person@example.test" };

    await expect(hooks.before(user)).rejects.toThrow("cleanup failed");
    await hooks.after(user);

    expect(complete).not.toHaveBeenCalled();
  });

  it("does not report deletion as failed when only the completion marker cannot be appended", async () => {
    const hooks = createUserErasureHooks({
      request: async () => "receipt-1",
      cleanup: async () => {},
      complete: async () => {
        throw new Error("disk became read-only");
      },
    });
    const user = { id: "user-1", email: "person@example.test" };
    await hooks.before(user);
    await expect(hooks.after(user)).resolves.toBeUndefined();
  });
});
