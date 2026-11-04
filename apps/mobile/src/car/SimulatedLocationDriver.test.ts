import { SimulatedLocationDriver } from "./SimulatedLocationDriver";

it("replays once and cancels delivery on stop", async () => {
  jest.useFakeTimers();
  const deliver = jest.fn(async () => {});
  const driver = new SimulatedLocationDriver(
    // About 22 m apart: three fixes at 10 m/s, interpolated along the line.
    [
      [13.4, 52.5],
      [13.4, 52.5002],
    ],
    deliver,
    () => 1234,
  );
  await driver.start({} as never);
  await jest.advanceTimersByTimeAsync(1000);
  expect(deliver).toHaveBeenCalledWith(
    expect.objectContaining({ coords: [13.4, 52.5], timestampMs: 1234, speedMps: 10 }),
  );
  await driver.stop();
  await jest.advanceTimersByTimeAsync(5000);
  expect(deliver).toHaveBeenCalledTimes(1);
  jest.useRealTimers();
});

it("moves at constant speed between route points", async () => {
  jest.useFakeTimers();
  const fixes: [number, number][] = [];
  const driver = new SimulatedLocationDriver(
    [
      [13.4, 52.5],
      [13.4, 52.5002],
    ],
    async (fix) => {
      fixes.push(fix.coords);
    },
  );
  await driver.start({} as never);
  await jest.advanceTimersByTimeAsync(10000);
  // Two route points, but each second advances 10 m: the drive passes between them.
  expect(fixes.length).toBeGreaterThan(2);
  expect(fixes[1]?.[1]).toBeGreaterThan(52.5);
  expect(fixes[1]?.[1]).toBeLessThan(52.5002);
  jest.useRealTimers();
});
