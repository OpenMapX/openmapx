import { describe, expect, it } from "vitest";
import type { BridgeClient } from "./bridgeClient";
import { BridgeError } from "./bridgeClient";
import { browserForegroundFix, nativeForegroundFix } from "./foregroundLocation";

function geolocationThat(
  behaviour:
    | { ok: { latitude: number; longitude: number; accuracy?: number } }
    | { errorCode: number },
): Geolocation {
  return {
    getCurrentPosition: (
      success: PositionCallback,
      failure?: PositionErrorCallback | null,
      _options?: PositionOptions,
    ) => {
      if ("ok" in behaviour) {
        success({
          coords: {
            latitude: behaviour.ok.latitude,
            longitude: behaviour.ok.longitude,
            accuracy: behaviour.ok.accuracy ?? 12,
            heading: null,
            speed: null,
            altitude: null,
            altitudeAccuracy: null,
          },
          timestamp: 1_700_000_000_000,
        } as unknown as GeolocationPosition);
        return;
      }
      failure?.({ code: behaviour.errorCode } as unknown as GeolocationPositionError);
    },
  } as unknown as Geolocation;
}

/** A client whose single request answers with `answer`, recording the payload. */
function fakeClient(answer: () => unknown) {
  const sent: { type: string; payload: Record<string, unknown> }[] = [];
  const client = {
    request: (type: string, payload: Record<string, unknown>) => {
      sent.push({ type, payload });
      const result = answer();
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  } as unknown as BridgeClient;
  return { client, sent };
}

const locationResult = (payload: Record<string, unknown>) => ({
  type: "location.result",
  payload,
});

const fix = { lat: 50.11, lng: 8.68, accuracy: 8, timestampMs: 1_700_000_000_000 };

describe("browserForegroundFix", () => {
  it("returns the browser's fix", async () => {
    const result = await browserForegroundFix(
      {},
      geolocationThat({ ok: { latitude: 50.11, longitude: 8.68 } }),
    );

    expect(result).toEqual({
      status: "ok",
      fix: {
        lat: 50.11,
        lng: 8.68,
        accuracy: 12,
        heading: undefined,
        speed: undefined,
        timestampMs: 1_700_000_000_000,
      },
    });
  });

  it.each([
    { label: "a denial", errorCode: 1, status: "denied" },
    { label: "a timeout", errorCode: 3, status: "timeout" },
    { label: "an unavailable sensor", errorCode: 2, status: "unavailable" },
  ])("reports $label distinctly", async ({ errorCode, status }) => {
    // One is worth retrying; the other is a trip to settings.
    expect(await browserForegroundFix({}, geolocationThat({ errorCode }))).toEqual({ status });
  });

  it("reports a browser with no geolocation at all", async () => {
    expect(await browserForegroundFix({}, undefined)).toEqual({ status: "unavailable" });
  });

  it("passes through only the options the caller asked for", async () => {
    let seen: PositionOptions | undefined;
    const geolocation = {
      getCurrentPosition: (_ok: PositionCallback, _fail: unknown, options?: PositionOptions) => {
        seen = options;
      },
    } as unknown as Geolocation;

    void browserForegroundFix({ maxAgeMs: 0 }, geolocation);

    // Silently adding a timeout or a high-accuracy request here would change
    // behaviour for every existing PWA user to tidy a path they never see.
    expect(seen).toEqual({ maximumAge: 0 });
  });
});

describe("nativeForegroundFix", () => {
  it("asks for exactly one bounded fix", async () => {
    const { client, sent } = fakeClient(() =>
      locationResult({ requestId: "r1", status: "ok", fix }),
    );

    const result = await nativeForegroundFix(client, "r1", { accuracy: "balanced" });

    expect(result).toEqual({ status: "ok", fix });
    expect(sent[0].type).toBe("location.request");
    expect(sent[0].payload).toMatchObject({ requestId: "r1", accuracy: "balanced" });
    // No watch option exists to set: there is one location producer.
    expect(sent[0].payload.watch).toBeUndefined();
  });

  it("ignores an answer to a request it is no longer waiting on", async () => {
    const { client } = fakeClient(() => locationResult({ requestId: "stale", status: "ok", fix }));

    // A stale fix arriving late would move the map under someone who has since
    // asked again.
    expect(await nativeForegroundFix(client, "r2")).toEqual({ status: "unavailable" });
  });

  it.each([
    { label: "denial", status: "denied" },
    { label: "timeout", status: "timeout" },
    { label: "an unavailable sensor", status: "unavailable" },
  ])("passes through native $label", async ({ status }) => {
    const { client } = fakeClient(() => locationResult({ requestId: "r1", status }));

    expect(await nativeForegroundFix(client, "r1")).toEqual({ status });
  });

  it("reports a v1 shell as unsupported rather than falling back", async () => {
    const { client } = fakeClient(() => new BridgeError("unsupported-capability"));

    // Falling back to browser geolocation here would restore the second location
    // producer, on exactly the devices running the oldest binaries.
    expect(await nativeForegroundFix(client, "r1")).toEqual({ status: "unsupported" });
  });

  it("treats an unexpected reply as unavailable", async () => {
    const { client } = fakeClient(() => ({ type: "snapshot.update", payload: {} }));

    expect(await nativeForegroundFix(client, "r1")).toEqual({ status: "unavailable" });
  });

  it("gives the shell slack past its own deadline", async () => {
    const { client, sent } = fakeClient(() =>
      locationResult({ requestId: "r1", status: "ok", fix }),
    );

    await nativeForegroundFix(client, "r1", { timeoutMs: 5_000 });

    // So the shell's own answer wins the race and the page reports what really
    // happened rather than a generic timeout.
    expect(sent[0].payload.timeoutMs).toBe(5_000);
  });
});
