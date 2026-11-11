import { describe, expect, it } from "vitest";
import { parseCarSurfaceMessage } from "./carSurfaceProtocol";
import { MAX_MESSAGE_BYTES, MAX_TOTAL_COORDINATES } from "./mobileProtocol";

const parse = (v: unknown) => parseCarSurfaceMessage(JSON.stringify(v));
describe("car surface protocol", () => {
  it.each([
    { type: "car-ready" },
    { type: "car-map-state", following: true },
    { type: "car-error", code: "webgl-lost" },
    { type: "car-hello", locale: "de", units: "imperial", dark: true },
    {
      type: "car-viewport",
      width: 800,
      height: 240,
      stable: { top: 10, right: 20, bottom: 30, left: 40 },
      visible: { top: 0, right: 0, bottom: 0, left: 0 },
      dark: false,
    },
    { type: "car-preview", routes: [] },
    {
      type: "car-preview",
      routes: [
        {
          coordinates: [
            [13, 52],
            [14, 53],
          ],
        },
      ],
      selected: 0,
    },
    { type: "car-camera", action: "pan", dx: 12, dy: -40 },
    { type: "car-camera", action: "fling", vx: 20, vy: 30 },
    { type: "car-camera", action: "zoom", factor: 2, x: 40, y: 50 },
    { type: "car-camera", action: "recenter" },
    {
      type: "car-snapshot",
      message: {
        protocolVersion: 3,
        type: "session.stopped",
        messageId: "m",
        channelNonce: "c",
        sentAtMs: 0,
        payload: { sessionId: "s", revision: 2, finalStatus: "stopped" },
      },
    },
  ])("accepts $type", (message) => expect(parse({ v: 1, ...message }).ok).toBe(true));
  it.each([
    { v: 2, type: "car-ready" },
    { v: 1, type: "car-ready", extra: true },
    { v: 1, type: "car-camera", action: "zoom", factor: 0 },
    {
      v: 1,
      type: "car-preview",
      routes: [
        {
          coordinates: [
            [13, 52],
            [14, 53],
          ],
        },
      ],
      selected: 1,
    },
    {
      v: 1,
      type: "car-preview",
      routes: [
        {
          coordinates: [
            [181, 52],
            [14, 53],
          ],
        },
      ],
      selected: 0,
    },
    { v: 1, type: "car-snapshot", message: { type: "auth.result" } },
  ])("rejects malformed input", (message) => expect(parse(message).ok).toBe(false));
  it("rejects invalid JSON and byte overflow before decoding", () => {
    expect(parseCarSurfaceMessage("{").ok).toBe(false);
    expect(parseCarSurfaceMessage(" ".repeat(MAX_MESSAGE_BYTES + 1))).toEqual({
      ok: false,
      error: { code: "payload-too-large" },
    });
  });
  it("bounds aggregate preview coordinates", () => {
    expect(
      parse({
        v: 1,
        type: "car-preview",
        selected: 0,
        routes: [
          { coordinates: Array.from({ length: MAX_TOTAL_COORDINATES }, () => [0, 0]) },
          {
            coordinates: [
              [0, 0],
              [1, 1],
            ],
          },
        ],
      }).ok,
    ).toBe(false);
  });
  it("reuses snapshot aggregate limits", () => {
    expect(
      parse({
        v: 1,
        type: "car-snapshot",
        message: {
          protocolVersion: 3,
          type: "snapshot.update",
          messageId: "m",
          channelNonce: "c",
          sentAtMs: 0,
          payload: {
            snapshot: {
              type: "full",
              sessionId: "s",
              revision: 1,
              routeFingerprint: "f",
              route: { geometry: Array.from({ length: MAX_TOTAL_COORDINATES + 1 }, () => [0, 0]) },
            },
          },
        },
      }),
    ).toEqual({ ok: false, error: { code: "too-many-coordinates" } });
  });
});
