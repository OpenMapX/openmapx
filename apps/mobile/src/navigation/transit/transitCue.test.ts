import type { TransitNavigationEvent } from "@openmapx/core/navigation";
import { MAX_CUE_ID_LENGTH } from "../../audio/navigationAudio";
import { FIXTURE_FINGERPRINT, transitSessionFixture } from "./testing/transitFixture";
import {
  boundedName,
  MAX_ALERT_TEXT_LENGTH,
  speakableAlertText,
  transitCueEffect,
  transitCueId,
  transitWalkCueEffect,
} from "./transitCue";

const session = (overrides = {}) => transitSessionFixture(overrides);

function event(overrides: Partial<TransitNavigationEvent> = {}): TransitNavigationEvent {
  return { id: "ev-1", type: "board", legIndex: 1, ...overrides } as TransitNavigationEvent;
}

describe("boundedName", () => {
  it("keeps an ordinary name", () => {
    expect(boundedName("Hauptbahnhof")).toBe("Hauptbahnhof");
  });

  it("trims surrounding whitespace", () => {
    expect(boundedName("  Messe  ")).toBe("Messe");
  });

  it("removes control characters rather than escaping them", () => {
    // A synthesiser reading a line separator produces nothing useful, and
    // leaving them in only widens what a malformed feed can do.
    expect(boundedName("Messe\u2028West")).toBe("Messe West");
    expect(boundedName("Messe\u0000\u0001West")).toBe("Messe West");
    expect(boundedName("Line\nbreak")).toBe("Line break");
  });

  it("refuses an empty or whitespace-only name", () => {
    expect(boundedName("")).toBeNull();
    expect(boundedName("   ")).toBeNull();
  });

  it("refuses anything that is not a string", () => {
    for (const value of [undefined, null, 42, {}, []]) expect(boundedName(value)).toBeNull();
  });

  it("refuses a name longer than its bound", () => {
    expect(boundedName("x".repeat(121))).toBeNull();
    expect(boundedName("x".repeat(80), 64)).toBeNull();
  });
});

describe("transitCueId", () => {
  it("is stable for the same session, itinerary and event", () => {
    expect(transitCueId("s1", FIXTURE_FINGERPRINT, "ev-1")).toBe(
      transitCueId("s1", FIXTURE_FINGERPRINT, "ev-1"),
    );
  });

  it("changes with the itinerary, so a replan reopens the cue namespace", () => {
    expect(transitCueId("s1", "it-a", "ev-1")).not.toBe(transitCueId("s1", "it-b", "ev-1"));
  });

  it("stays within the audio module's identifier bound", () => {
    expect(
      transitCueId("s".repeat(200), "f".repeat(200), "e".repeat(200)).length,
    ).toBeLessThanOrEqual(MAX_CUE_ID_LENGTH);
  });

  it("derives from the event, never from a title a feed supplied", () => {
    const id = transitCueId("s1", FIXTURE_FINGERPRINT, "ev-1");

    expect(id).not.toContain("Hauptbahnhof");
  });
});

describe("transitCueEffect", () => {
  it("announces boarding with the line, destination and platform", () => {
    const cue = transitCueEffect(session(), event({ type: "board", legIndex: 1 }));

    expect(cue?.effect.text).toContain("S1");
    expect(cue?.effect.text).toContain("Wiesbaden");
    expect(cue?.effect.text).toContain("3");
    expect(cue?.critical).toBe(true);
  });

  it("announces boarding without a platform when the feed has none", () => {
    const noPlatform = session();
    const legs = (
      noPlatform.payload.startPackage.itinerary as { legs: Array<Record<string, never>> }
    ).legs;
    (legs[1] as unknown as { from: { platformCode?: string } }).from.platformCode = undefined;

    const cue = transitCueEffect(noPlatform, event({ type: "board", legIndex: 1 }));

    expect(cue?.effect.text).toContain("S1");
  });

  it("names the stop when alighting", () => {
    const cue = transitCueEffect(session(), event({ type: "alight", legIndex: 1 }));

    expect(cue?.effect.text).toContain("Messe");
    expect(cue?.critical).toBe(true);
  });

  it("warns while approaching the alighting stop", () => {
    const cue = transitCueEffect(session(), {
      id: "ev-2",
      type: "approaching-alight",
      legIndex: 1,
      stopsRemaining: 1,
    });

    expect(cue?.effect.text).toContain("Messe");
  });

  it("names both the stop and the onward line at a transfer", () => {
    const cue = transitCueEffect(session(), {
      id: "ev-3",
      type: "transfer",
      fromLegIndex: 1,
      toLegIndex: 1,
    });

    expect(cue?.effect.text).toContain("Messe");
    expect(cue?.effect.text).toContain("S1");
  });

  it("announces a platform change", () => {
    const cue = transitCueEffect(session(), {
      id: "ev-4",
      type: "platform-change",
      legIndex: 1,
      platform: "7",
    });

    expect(cue?.effect.text).toContain("7");
    expect(cue?.critical).toBe(true);
  });

  it("announces a missed connection and an arrival", () => {
    expect(
      transitCueEffect(session(), { id: "ev-5", type: "missed-connection", legIndex: 1 })?.effect
        .text,
    ).toBeTruthy();
    expect(
      transitCueEffect(session(), { id: "ev-6", type: "arrival", legIndex: 2 })?.effect.text,
    ).toBeTruthy();
  });

  it("speaks German for a German session", () => {
    const cue = transitCueEffect(session({ locale: "de" }), event({ type: "alight", legIndex: 1 }));

    expect(cue?.effect.locale).toBe("de");
    expect(cue?.effect.text).toBeTruthy();
  });

  it("says nothing rather than half a sentence when a name is missing", () => {
    const nameless = session();
    const legs = (nameless.payload.startPackage.itinerary as { legs: unknown[] }).legs;
    (legs[1] as { route?: unknown; headsign?: unknown }).route = undefined;
    (legs[1] as { headsign?: unknown }).headsign = undefined;
    (legs[1] as { to?: { name?: string } }).to = { name: undefined };

    // "Board the" is worse than silence.
    expect(transitCueEffect(nameless, event({ type: "board", legIndex: 1 }))).toBeNull();
  });

  it("says nothing for a name a feed made absurdly long", () => {
    const long = session();
    const legs = (long.payload.startPackage.itinerary as { legs: unknown[] }).legs;
    (legs[1] as { to: { name: string } }).to = { name: "x".repeat(500) };

    expect(transitCueEffect(long, event({ type: "alight", legIndex: 1 }))).toBeNull();
  });

  it("uses the same identifier for the same event, so it is spoken once", () => {
    const first = transitCueEffect(session(), event());
    const second = transitCueEffect(session(), event());

    expect(first?.cueId).toBe(second?.cueId);
  });
});

describe("transitWalkCueEffect", () => {
  it("speaks a walking instruction", () => {
    const cue = transitWalkCueEffect(session(), "walk:1:2", "Turn left", "Hauptstraße");

    expect(cue?.effect.text).toContain("Turn left");
    expect(cue?.critical).toBe(false);
  });

  it("speaks an instruction with no street", () => {
    expect(transitWalkCueEffect(session(), "walk:1:2", "Continue straight")?.effect.text).toContain(
      "Continue straight",
    );
  });

  it("says nothing for an empty instruction", () => {
    expect(transitWalkCueEffect(session(), "walk:1:2", "   ")).toBeNull();
  });
});

describe("speakableAlertText", () => {
  it("speaks a critical alert's short text", () => {
    expect(speakableAlertText({ id: "a1", severity: "critical", header: "Line suspended" })).toBe(
      "Line suspended",
    );
  });

  it("speaks a severe alert", () => {
    expect(speakableAlertText({ id: "a1", severity: "severe", header: "Major delays" })).toBe(
      "Major delays",
    );
  });

  it.each(["warning", "info", undefined, "unknown"])("stays silent for %s severity", (severity) => {
    expect(speakableAlertText({ id: "a1", severity, header: "Something" })).toBeNull();
  });

  it("refuses an alert with no identity", () => {
    // The identifier is what ties an alert to the active itinerary; without one
    // there is nothing to tie it to.
    expect(speakableAlertText({ severity: "critical", header: "Line suspended" })).toBeNull();
    expect(speakableAlertText({ id: "", severity: "critical", header: "x" })).toBeNull();
  });

  it("refuses text beyond its bound", () => {
    expect(
      speakableAlertText({
        id: "a1",
        severity: "critical",
        header: "x".repeat(MAX_ALERT_TEXT_LENGTH + 1),
      }),
    ).toBeNull();
  });

  it("strips control characters a feed embedded", () => {
    expect(speakableAlertText({ id: "a1", severity: "critical", header: "Line\u2028down" })).toBe(
      "Line down",
    );
  });

  it("never reads a description or a URL", () => {
    // Those are arbitrary length, arbitrary content and often HTML.
    const alert = {
      id: "a1",
      severity: "critical",
      header: "Short",
      description: "<p>A very long description</p>",
      url: "https://example.org/alert",
    };

    expect(speakableAlertText(alert)).toBe("Short");
  });
});
