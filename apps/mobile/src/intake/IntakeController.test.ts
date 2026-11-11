import { IntakeController } from "./IntakeController";
import type { NativeIntakePort } from "./nativeIntakeModule";

const id = "f386e706-b728-40a3-9554-881d0ff0958a";
function fixture() {
  let nonce = "first";
  let release: (() => void) | undefined;
  const port = {
    available: async () => true,
    list: jest.fn(async () => []),
    read: jest.fn(),
    complete: jest.fn(),
    listen: () => () => undefined,
  } as NativeIntakePort;
  const send = jest.fn();
  const canApply = jest.fn(async () => true);
  const controller = new IntakeController({
    port,
    currentNonce: () => nonce,
    send,
    canApply,
    scheme: "openmapx",
  });
  return {
    controller,
    canApply,
    port,
    send,
    reset: () => {
      nonce = "second";
    },
    delay: () => {
      port.list = () =>
        new Promise((r) => {
          release = () => r([]);
        });
    },
    release: () => release?.(),
  };
}
const message = (type: string, payload = {}) => ({
  type,
  payload,
  messageId: "request1",
  channelNonce: "first",
  protocolVersion: 4,
  sentAtMs: 0,
});
it("correlates an empty list without claiming apply authority", async () => {
  const f = fixture();
  await f.controller.dispatch(message("intake.list") as never);
  expect(f.send).toHaveBeenCalledWith(
    "intake.items",
    { items: [], canApply: false, scheme: "openmapx" },
    { forMessageId: "request1" },
  );
});
it("drops replies after a document reload", async () => {
  const f = fixture();
  f.delay();
  const pending = f.controller.dispatch(message("intake.list") as never);
  f.reset();
  f.release();
  await pending;
  expect(f.send).not.toHaveBeenCalled();
});
it("does not delete read items, and completes only explicitly", async () => {
  const f = fixture();
  await f.controller.dispatch(message("intake.read", { id, offset: 0 }) as never);
  expect(f.port.complete).not.toHaveBeenCalled();
  await f.controller.dispatch(
    message("intake.complete", { id, disposition: "discarded" }) as never,
  );
  expect(f.port.complete).toHaveBeenCalledWith(id);
});
it("never dispatches a command from an obsolete document", async () => {
  const f = fixture();
  f.reset();
  await f.controller.dispatch(
    message("intake.complete", { id, disposition: "discarded" }) as never,
  );
  expect(f.port.complete).not.toHaveBeenCalled();
});

it("does not query unavailable navigation authority for an empty inbox", async () => {
  const f = fixture();
  f.canApply.mockRejectedValue(new Error("startup failed"));
  await f.controller.dispatch(message("intake.list") as never);
  expect(f.canApply).not.toHaveBeenCalled();
  expect(f.send).toHaveBeenCalledWith(
    "intake.items",
    expect.objectContaining({ items: [], canApply: false }),
    { forMessageId: "request1" },
  );
});
