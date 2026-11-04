import { SimulatedLocationDriver } from "./SimulatedLocationDriver";

it("replays once and cancels delivery on stop", async () => {
  jest.useFakeTimers();
  const deliver = jest.fn(async () => {});
  const driver = new SimulatedLocationDriver(
    [
      [1, 2],
      [3, 4],
    ],
    deliver,
    () => 1234,
  );
  await driver.start({} as never);
  await jest.advanceTimersByTimeAsync(1000);
  expect(deliver).toHaveBeenCalledWith(
    expect.objectContaining({ coords: [1, 2], timestampMs: 1234 }),
  );
  await driver.stop();
  await jest.advanceTimersByTimeAsync(5000);
  expect(deliver).toHaveBeenCalledTimes(1);
  jest.useRealTimers();
});
