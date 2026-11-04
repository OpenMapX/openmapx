import { describe, expect, it, vi } from "vitest";
import { NativeIntakeClient } from "./nativeIntake";

const id = "f386e706-b728-40a3-9554-881d0ff0958a";
const item = { id, createdAtMs: 1, kind: "text" as const, name: "Shared location", byteLength: 6 };
describe("native intake transfer", () => {
  it("checks exact bytes/offset/EOF without acknowledging reads", async () => {
    const request = vi.fn(async () => ({
      type: "intake.chunk",
      payload: {
        id,
        offset: 0,
        data: btoa("Berlin"),
        byteLength: 6,
        eof: true,
        forMessageId: "r1",
      },
    }));
    const client = new NativeIntakeClient({ request } as never);
    expect(await client.text(item, new AbortController().signal)).toBe("Berlin");
    expect(request.mock.calls).toHaveLength(1);
  });
  it.each([
    { offset: 24576 },
    { eof: false },
    { byteLength: 5 },
    { data: "not-base64" },
    { id: "different" },
    { data: btoa("1234567") },
  ])("rejects corrupt chunks %j", async (patch) => {
    const request = vi.fn(async () => ({
      type: "intake.chunk",
      payload: { id, offset: 0, data: btoa("Berlin"), byteLength: 6, eof: true, ...patch },
    }));
    await expect(
      new NativeIntakeClient({ request } as never).text(item, new AbortController().signal),
    ).rejects.toThrow();
  });
  it("rejects cancellation and invalid UTF8", async () => {
    const request = vi.fn(async () => ({
      type: "intake.chunk",
      payload: { id, offset: 0, data: btoa("\xff\xff\xff\xff\xff\xff"), byteLength: 6, eof: true },
    }));
    const client = new NativeIntakeClient({ request } as never);
    await expect(client.text(item, new AbortController().signal)).rejects.toThrow();
    const abort = new AbortController();
    abort.abort();
    await expect(client.text(item, abort.signal)).rejects.toThrow();
  });
});

it("validates metadata before allocating and enforces the total transfer deadline", async () => {
  const request = vi.fn(async () => ({
    type: "intake.chunk",
    payload: { id, offset: 0, data: btoa("Berlin"), byteLength: 6, eof: true },
  }));
  const client = new NativeIntakeClient({ request } as never);
  await expect(
    client.text({ ...item, byteLength: 999999999 }, new AbortController().signal),
  ).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
  let calls = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => (++calls < 4 ? 1000 : 62000));
  try {
    await expect(client.text(item, new AbortController().signal)).rejects.toThrow();
  } finally {
    clock.mockRestore();
  }
});
it("reads every aligned chunk and verifies the short final chunk", async () => {
  const request = vi.fn(async (...args: unknown[]) => {
    const payload = args[1] as { offset: number };
    const count = Math.min(24576, 50000 - payload.offset);
    return {
      type: "intake.chunk",
      payload: {
        id,
        offset: payload.offset,
        data: btoa("x".repeat(count)),
        byteLength: count,
        eof: payload.offset + count === 50000,
      },
    };
  });
  const client = new NativeIntakeClient({ request } as never);
  expect(
    await client.text(
      { ...item, kind: "file", format: "gpx", name: "route.gpx", byteLength: 50000 },
      new AbortController().signal,
    ),
  ).toHaveLength(50000);
  expect(request.mock.calls.map((call) => (call[1] as { offset: number }).offset)).toEqual([
    0, 24576, 49152,
  ]);
});

it("keeps closed native failure codes without exposing arbitrary native error text", async () => {
  const request = vi.fn(async () => ({
    type: "native.error",
    payload: { code: "expired", forMessageId: "r1" },
  }));
  const client = new NativeIntakeClient({ request } as never);
  await expect(client.text(item, new AbortController().signal)).rejects.toMatchObject({
    code: "expired",
  });
  request.mockResolvedValue({
    type: "native.error",
    payload: { code: "/private/sender-path", forMessageId: "r2" },
  });
  await expect(client.list()).rejects.toMatchObject({ code: "unavailable" });
});
