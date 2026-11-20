import type { SessionRepository } from "../storage/SessionRepository";
import { nativeCar } from "./nativeCar";
import { publishCarState } from "./publishCarState";

jest.mock("./nativeCar", () => ({ nativeCar: jest.fn() }));

import { groundSessionFixture } from "../storage/testing/sessionFixture";

it("publishes without a phone, drops stale revisions, coalesces and clears on termination", async () => {
  jest.useFakeTimers();
  const publish = jest.fn(async (_json: string) => {});
  const published = (index: number) => {
    const call = publish.mock.calls[index];
    if (!call) throw new Error(`nothing was published at call ${index}`);
    return JSON.parse(call[0]);
  };
  (nativeCar as jest.Mock).mockReturnValue({ publish });
  let session: object | null = {
    ...groundSessionFixture(),
    kind: "ground",
    status: "active",
    sessionId: "s",
    revision: 3,
    locale: "en",
    units: "metric",
  };
  const repository = {
    loadActive: async () => session,
    readTerminalAck: async () => ({ finalRevision: 4, finalStatus: "arrived" }),
  } as unknown as SessionRepository;
  await publishCarState(repository, 1000, true);
  expect(published(0).message.payload.snapshot.revision).toBe(3);
  session = { ...session, revision: 2 };
  await publishCarState(repository, 1100, true);
  expect(publish).toHaveBeenCalledTimes(1);
  session = { ...session, revision: 4 };
  await publishCarState(repository, 1200);
  expect(publish).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1000);
  expect(publish).toHaveBeenCalledTimes(2);
  expect(published(1).message.payload.snapshot.type).toBe("progress");
  session = null;
  await publishCarState(repository, 3000, true);
  expect(published(2)).toMatchObject({
    projection: null,
    message: { type: "session.stopped", payload: { finalStatus: "arrived", revision: 4 } },
  });
  jest.useRealTimers();
});
