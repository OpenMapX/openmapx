import { createAudioArbiter } from "./audioArbiter";

const cue = (cueId: string) => ({ cueId, text: "Turn left", locale: "en" as const });
function fixture(speaking = false) {
  let now = 0;
  const audio = {
    speak: jest.fn(async () => "spoken" as const),
    stop: jest.fn(async () => {}),
    getStatus: jest.fn(async () => ({
      initialized: true,
      speaking,
      localeAvailable: true,
      lastResultCode: null,
    })),
  };
  const arbiter = createAudioArbiter(
    audio,
    () => now,
    async (ms) => {
      now += ms;
    },
  );
  return {
    audio,
    arbiter,
    elapsed: () => now,
    age: (ms: number) => {
      now += ms;
    },
  };
}
it("holds only the latest cue and releases it", async () => {
  const f = fixture();
  await f.arbiter.acquire(() => true);
  await f.arbiter.speak(cue("a"));
  await f.arbiter.speak(cue("b"));
  expect(f.audio.speak).not.toHaveBeenCalled();
  await f.arbiter.release();
  expect(f.audio.speak).toHaveBeenCalledWith(cue("b"));
});
it("drops stale guidance with stable status", async () => {
  const f = fixture();
  await f.arbiter.acquire(() => true);
  await f.arbiter.speak(cue("a"));
  f.age(10001);
  await f.arbiter.release();
  expect(f.audio.speak).not.toHaveBeenCalled();
  expect((await f.arbiter.getStatus()).lastResultCode).toBe("voice-guidance-stale");
});
it("waits at most six seconds for speaking guidance then stops it", async () => {
  const f = fixture(true);
  f.audio.stop.mockImplementation(async () => {
    f.audio.getStatus.mockResolvedValue({
      initialized: true,
      speaking: false,
      localeAvailable: true,
      lastResultCode: null,
    });
  });
  await f.arbiter.acquire(() => true);
  expect(f.audio.stop).toHaveBeenCalledTimes(1);
  expect(f.elapsed()).toBeGreaterThanOrEqual(6000);
  expect(f.elapsed()).toBeLessThanOrEqual(6050);
});
it("waits for guidance completion then flushes the native queue", async () => {
  const f = fixture(true);
  f.audio.getStatus
    .mockResolvedValueOnce({
      initialized: true,
      speaking: true,
      localeAvailable: true,
      lastResultCode: null,
    })
    .mockResolvedValue({
      initialized: true,
      speaking: false,
      localeAvailable: true,
      lastResultCode: null,
    });
  await f.arbiter.acquire(() => true);
  expect(f.audio.stop).toHaveBeenCalledTimes(1);
});

it("refuses recognition if guidance does not stop", async () => {
  const f = fixture(true);
  await expect(f.arbiter.acquire(() => true)).rejects.toThrow("guidance-still-speaking");
});
