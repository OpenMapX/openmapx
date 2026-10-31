import { expect, it } from "vitest";
import { BoundedServiceLogBuffer, MAX_SERVICE_LOG_BYTES } from "./service-log-buffer";

it("retains the newest1000 lines and flags discarded output", () => {
  const buffer = new BoundedServiceLogBuffer();
  buffer.append(Array.from({ length: 1002 }, (_, i) => `line-${i}`).join("\n") + "\n");
  expect(buffer.snapshot().lines).toHaveLength(1000);
  expect(buffer.snapshot().lines[0]).toBe("line-2");
  expect(buffer.snapshot().truncated).toBe(true);
});
it("bounds an incomplete Unicode line and finishes without splitting encoded characters", () => {
  const buffer = new BoundedServiceLogBuffer();
  buffer.append("😀".repeat(100000));
  const state = buffer.snapshot();
  expect(new TextEncoder().encode(state.lines.join("\n")).length).toBeLessThanOrEqual(
    MAX_SERVICE_LOG_BYTES,
  );
  expect(state.lines.join("")).not.toContain("�");
  expect(state.truncated).toBe(true);
  buffer.finish();
  expect(buffer.snapshot().lines).toHaveLength(1);
});
it("retains partial chunks and blank lines without exceeding total byte retention", () => {
  const buffer = new BoundedServiceLogBuffer();
  buffer.append("part");
  buffer.append("ial\n\nlast");
  buffer.finish();
  expect(buffer.snapshot().lines).toEqual(["partial", "", "last"]);
  buffer.append(("x".repeat(10000) + "\n").repeat(100));
  const state = buffer.snapshot();
  expect(new TextEncoder().encode(state.lines.join("\n")).length).toBeLessThanOrEqual(
    MAX_SERVICE_LOG_BYTES,
  );
  expect(state.truncated).toBe(true);
});
it("flags truncation when a long partial line arrives in individually small chunks", () => {
  const buffer = new BoundedServiceLogBuffer();
  for (let i = 0; i < 4; i++) buffer.append("x".repeat(100000));
  expect(buffer.snapshot().truncated).toBe(true);
  expect(new TextEncoder().encode(buffer.snapshot().lines.join("\n")).length).toBeLessThanOrEqual(
    MAX_SERVICE_LOG_BYTES,
  );
});
