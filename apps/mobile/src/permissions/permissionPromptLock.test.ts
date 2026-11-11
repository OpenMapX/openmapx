import { withPermissionPrompt } from "./permissionPromptLock";

function deferred() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("withPermissionPrompt", () => {
  it("shows one prompt at a time, in the order they were asked for", async () => {
    const order: string[] = [];
    const first = deferred();
    const a = withPermissionPrompt(async () => {
      order.push("a:start");
      await first.promise;
      order.push("a:end");
    });
    const b = withPermissionPrompt(async () => {
      order.push("b");
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(["a:start"]);

    first.release();
    await Promise.all([a, b]);
    expect(order).toEqual(["a:start", "a:end", "b"]);
  });

  it("does not let a failed prompt hold up the next", async () => {
    const failed = withPermissionPrompt(async () => {
      throw new Error("prompt failed");
    });
    await expect(failed).rejects.toThrow("prompt failed");
    await expect(withPermissionPrompt(async () => "granted")).resolves.toBe("granted");
  });
});
