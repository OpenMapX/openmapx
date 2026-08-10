import { describe, expect, it } from "vitest";
import {
  MAX_MESSAGE_BYTES,
  MAX_TOTAL_COORDINATES,
  MAX_TOTAL_STEPS,
  MOBILE_PROTOCOL_MAX,
  MOBILE_PROTOCOL_MIN,
  NATIVE_TO_WEB_TYPES,
  negotiateMobileProtocol,
  parseMobileBridgeMessage,
  WEB_TO_NATIVE_TYPES,
} from "./mobileProtocol";

const NONCE = "channel-nonce-abc";
const NOW = 1_700_000_000_000;

function line(index: number): [number, number] {
  return [8.6 + index / 100_000, 50.1 + index / 100_000];
}

function route(coordinates = 4, steps = 2) {
  return {
    distance: 1200,
    duration: 300,
    geometry: Array.from({ length: coordinates }, (_, i) => line(i)),
    steps: Array.from({ length: steps }, () => ({ instruction: "Turn right", distance: 100 })),
    mode: "driving",
  };
}

function groundPackage() {
  return {
    kind: "ground",
    route: route(),
    alternatives: [],
    mode: "driving",
    destinationWaypoints: [line(0), line(3)],
    routeSelectionIntent: "automatic",
    routeOptions: {},
    locale: "en",
    units: "metric",
    settings: { voiceEnabled: true, keepScreenOn: true, voiceTiming: "normal" },
  };
}

function transitPackage() {
  return {
    kind: "transit",
    itinerary: { legs: [] },
    captures: [
      {
        legIndex: 0,
        tripId: "trip-1",
        capturedAtMs: NOW,
        status: "captured",
        stops: [{ stopId: "s1", name: "Hauptbahnhof", lat: 50.1, lng: 8.6 }],
      },
    ],
    locale: "de",
    units: "metric",
    settings: { voiceEnabled: true, keepScreenOn: false, alightAlertsEnabled: true },
    itineraryFingerprint: "fp-1",
  };
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    type: "session.prepare",
    messageId: "m-1",
    channelNonce: NONCE,
    sentAtMs: NOW,
    payload: { startPackage: groundPackage() },
    ...overrides,
  };
}

const parse = (value: unknown, options = {}) =>
  parseMobileBridgeMessage(JSON.stringify(value), { expectedNonce: NONCE, nowMs: NOW, ...options });

/** Narrows the discriminated result so a failing case can assert its code. */
const errorCodeOf = (result: ReturnType<typeof parse>) =>
  result.ok ? undefined : result.error.code;

describe("negotiateMobileProtocol", () => {
  it.each([
    [{ min: 1, max: 1 }, { min: 1, max: 1 }, 1],
    [{ min: 1, max: 2 }, { min: 2, max: 3 }, 2],
    [{ min: 1, max: 3 }, { min: 1, max: 2 }, 2],
    [{ min: 1, max: 1 }, { min: 2, max: 2 }, null],
    [{ min: 3, max: 4 }, { min: 1, max: 2 }, null],
  ] as const)("negotiates the highest overlap", (web, native, expected) => {
    expect(negotiateMobileProtocol(web, native)).toBe(expected);
  });

  it("declares a coherent supported range", () => {
    expect(MOBILE_PROTOCOL_MIN).toBeLessThanOrEqual(MOBILE_PROTOCOL_MAX);
    expect(
      negotiateMobileProtocol(
        { min: MOBILE_PROTOCOL_MIN, max: MOBILE_PROTOCOL_MAX },
        { min: MOBILE_PROTOCOL_MIN, max: MOBILE_PROTOCOL_MAX },
      ),
    ).toBe(MOBILE_PROTOCOL_MAX);
  });
});

describe("the command surface", () => {
  it("exposes no generic native invocation", () => {
    const all = [...WEB_TO_NATIVE_TYPES, ...NATIVE_TO_WEB_TYPES].join(" ");
    for (const forbidden of ["invoke", "eval", "exec", "fetch", "sql", "file", "speak", "notify"]) {
      expect(all).not.toContain(forbidden);
    }
  });

  it("accepts a valid ground preparation", () => {
    const result = parse(message());
    expect(result.ok).toBe(true);
  });

  it("accepts a valid transit preparation", () => {
    const result = parse(message({ payload: { startPackage: transitPackage() } }));
    expect(result.ok).toBe(true);
  });

  it("round-trips a ground package through JSON without losing shape", () => {
    const result = parse(message());
    if (!result.ok) throw new Error("expected success");
    const payload = result.message.payload as {
      startPackage: { kind: string; route: { geometry: unknown[] } };
    };
    expect(payload.startPackage.kind).toBe("ground");
    expect(payload.startPackage.route.geometry).toHaveLength(4);
  });
});

describe("rejection", () => {
  it("rejects the wrong channel nonce", () => {
    const result = parse(message({ channelNonce: "someone-elses-nonce" }));
    expect(result).toEqual({ ok: false, error: { code: "wrong-channel" } });
  });

  it("rejects an unknown message type", () => {
    expect(parse(message({ type: "session.destroyEverything" })).ok).toBe(false);
  });

  it("rejects unknown keys in the envelope", () => {
    expect(parse(message({ escalate: true })).ok).toBe(false);
  });

  it("rejects unknown keys in a start package", () => {
    const bad = { ...groundPackage(), evalScript: "alert(1)" };
    expect(parse(message({ payload: { startPackage: bad } })).ok).toBe(false);
  });

  it("rejects malformed JSON", () => {
    expect(parseMobileBridgeMessage("{not json", { expectedNonce: NONCE })).toEqual({
      ok: false,
      error: { code: "invalid-json" },
    });
  });

  it.each([
    ["stale", NOW - 10 * 60_000],
    ["future", NOW + 10 * 60_000],
  ])("rejects a %s timestamp", (_label, sentAtMs) => {
    expect(errorCodeOf(parse(message({ sentAtMs })))).toBe("timestamp-out-of-range");
  });

  it("accepts a timestamp inside the diagnostic window", () => {
    expect(parse(message({ sentAtMs: NOW - 60_000 })).ok).toBe(true);
  });

  it.each([
    ["latitude", [8.6, 91]],
    ["longitude", [181, 50.1]],
    ["non-finite", [Number.NaN, 50.1]],
  ])("rejects an invalid %s coordinate", (_label, coordinate) => {
    const bad = groundPackage();
    bad.route.geometry = [coordinate as [number, number], line(1)];
    expect(parse(message({ payload: { startPackage: bad } })).ok).toBe(false);
  });

  it("rejects a route with fewer than two geometry points", () => {
    const bad = groundPackage();
    bad.route.geometry = [line(0)];
    expect(parse(message({ payload: { startPackage: bad } })).ok).toBe(false);
  });

  it("rejects more than 512 legs", () => {
    const bad = groundPackage();
    (bad.route as { legs?: unknown[] }).legs = Array.from({ length: 513 }, () => ({}));
    const result = parse(message({ payload: { startPackage: bad } }));
    expect(result.ok).toBe(false);
  });

  it("rejects more than the aggregate step ceiling", () => {
    const bad = groundPackage();
    bad.route = route(4, MAX_TOTAL_STEPS + 1);
    expect(errorCodeOf(parse(message({ payload: { startPackage: bad } })))).toBe("too-many-steps");
  });

  it("rejects more than the aggregate coordinate ceiling", () => {
    const bad = groundPackage();
    bad.route = route(MAX_TOTAL_COORDINATES + 1, 1);
    expect(errorCodeOf(parse(message({ payload: { startPackage: bad } })))).toBe(
      "too-many-coordinates",
    );
  });

  it("rejects a message beyond the byte ceiling before parsing it", () => {
    const huge = `{"padding":"${"a".repeat(MAX_MESSAGE_BYTES + 16)}"}`;
    expect(parseMobileBridgeMessage(huge, { expectedNonce: NONCE })).toEqual({
      ok: false,
      error: { code: "payload-too-large" },
    });
  });

  it.each(["", "x".repeat(129)])("rejects the malformed message id %p", (messageId) => {
    expect(parse(message({ messageId })).ok).toBe(false);
  });

  it.each(["__proto__", "constructor", "prototype"])("rejects the polluting key %s", (key) => {
    const raw = `{"protocolVersion":1,"type":"snapshot.request","messageId":"m","channelNonce":"${NONCE}","sentAtMs":${NOW},"payload":{"${key}":{"polluted":true}}}`;
    expect(parseMobileBridgeMessage(raw, { expectedNonce: NONCE, nowMs: NOW })).toEqual({
      ok: false,
      error: { code: "prototype-pollution" },
    });
  });

  it("rejects a negative or non-integer revision", () => {
    expect(parse(message({ revision: -1 })).ok).toBe(false);
    expect(parse(message({ revision: 1.5 })).ok).toBe(false);
  });

  it("rejects a non-string input", () => {
    expect(parseMobileBridgeMessage(42 as unknown as string)).toEqual({
      ok: false,
      error: { code: "invalid-message" },
    });
  });
});

describe("error hygiene", () => {
  it("never returns the offending input", () => {
    const secret = "super-secret-refresh-token";
    const bad = { ...groundPackage(), refreshToken: secret };
    const result = parse(message({ payload: { startPackage: bad } }));
    expect(result.ok).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("8.6");
  });

  it("returns only a stable code", () => {
    const result = parse(message({ type: "nope" }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(Object.keys(result.error)).toEqual(["code"]);
  });
});

describe("native messages", () => {
  it("accepts a native hello", () => {
    const hello = message({
      type: "native.hello",
      payload: {
        shellVersion: "1.0.0",
        shellBuild: "1",
        selectedProtocolVersion: 1,
        minProtocolVersion: 1,
        maxProtocolVersion: 1,
        platform: "ios",
        capabilities: {
          groundNavigation: false,
          transitNavigation: false,
          backgroundLocation: true,
          localNotifications: true,
          speech: true,
        },
        permission: "not-determined",
        locationDriver: "expo",
        activeSession: null,
      },
    });
    expect(parse(hello).ok).toBe(true);
  });

  it("rejects a native error carrying a payload dump", () => {
    const bad = message({
      type: "native.error",
      payload: { code: "invalid-message", raw: { coords: [8.6, 50.1] } },
    });
    expect(parse(bad).ok).toBe(false);
  });
});
