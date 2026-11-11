import { describe, expect, it } from "vitest";
import {
  carDestinationSchema,
  carDestinationsSchema,
  MOBILE_PROTOCOL_MAX,
  parseMobileBridgeMessage,
} from "./mobileProtocol";

const place = { id: "p", label: "Berlin", coordinates: [13.4, 52.5] };
const payload = {
  account: "u",
  recent: [],
  saved: [place],
  locale: "de",
  units: "imperial",
  avoidHighways: true,
  avoidTolls: false,
  avoidFerries: false,
  avoidClosures: false,
  voiceEnabled: true,
  keepScreenOn: true,
  voiceTiming: "normal",
};
describe("car destinations boundary", () => {
  it("accepts bounded lists and explicit clearing", () => {
    expect(carDestinationsSchema.safeParse(payload).success).toBe(true);
    expect(carDestinationsSchema.safeParse({ ...payload, saved: [], account: null }).success).toBe(
      true,
    );
  });
  it.each([
    { ...place, coordinates: [181, 0] },
    { ...place, coordinates: [0, NaN] },
    { ...place, id: "x".repeat(129) },
    { ...place, label: "x".repeat(161) },
    { ...place, cookie: "secret" },
  ])("rejects invalid destination %j", (value) => {
    expect(carDestinationSchema.safeParse(value).success).toBe(false);
  });
  it("rejects oversized lists", () => {
    expect(
      carDestinationsSchema.safeParse({ ...payload, saved: Array(51).fill(place) }).success,
    ).toBe(false);
    expect(
      carDestinationsSchema.safeParse({ ...payload, recent: Array(21).fill(place) }).success,
    ).toBe(false);
  });
  it("bounds serialized UTF-8 bytes before dispatch", () => {
    const large = {
      ...payload,
      saved: Array.from({ length: 50 }, () => ({
        ...place,
        label: "\u0000".repeat(160),
        id: "\u0000".repeat(128),
      })),
    };
    const result = parseMobileBridgeMessage(
      JSON.stringify({
        protocolVersion: MOBILE_PROTOCOL_MAX,
        type: "destinations.update",
        messageId: "m",
        channelNonce: "c",
        sentAtMs: 1,
        payload: large,
      }),
    );
    // UTF-16 character bounds and the independent byte ceiling both apply.
    expect(result.ok).toBe(false);
  });
});
