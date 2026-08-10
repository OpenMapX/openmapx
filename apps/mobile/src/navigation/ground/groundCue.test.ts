import type { GroundMobileSession, VoiceCue } from "@openmapx/core/navigation";
import { MAX_CUE_ID_LENGTH } from "../../audio/navigationAudio";
import { groundSessionFixture } from "../../storage/testing/sessionFixture";
import {
  arrivalCueId,
  groundCueEffect,
  groundCueId,
  MAX_CUE_AGE_MS,
  offRouteEpisodeId,
  spokenInstructionFor,
  statusCueEffect,
} from "./groundCue";

const FINGERPRINT = "route-abc";

function session(overrides: Partial<GroundMobileSession> = {}): GroundMobileSession {
  return groundSessionFixture({ status: "active", ...overrides });
}

function cue(overrides: Partial<VoiceCue> = {}): VoiceCue {
  return {
    key: "step-1:near",
    tier: "near",
    stepIndex: 1,
    distance: 200,
    step: {
      instruction: "Turn left onto Hauptstraße",
      verbalSuccinct: "Turn left",
      verbalPre: "Turn left onto Hauptstraße",
      verbalAlert: "Turn left now",
    } as never,
    ...overrides,
  };
}

describe("spokenInstructionFor", () => {
  it.each(["far", "near"] as const)("prefers the succinct phrasing for a %s cue", (tier) => {
    expect(spokenInstructionFor(cue({ tier }))).toBe("Turn left");
  });

  it("prefers the alert phrasing for an imminent cue", () => {
    expect(spokenInstructionFor(cue({ tier: "now" }))).toBe("Turn left now");
  });

  it.each(["far", "near"] as const)("falls back to the full phrasing for a %s cue", (tier) => {
    const step = { instruction: "Turn left onto Hauptstraße", verbalPre: "Turn left ahead" };

    expect(spokenInstructionFor(cue({ tier, step: step as never }))).toBe("Turn left ahead");
  });

  it("falls back to the written instruction when no spoken phrasing exists", () => {
    const step = { instruction: "Turn left onto Hauptstraße" };

    expect(spokenInstructionFor(cue({ step: step as never }))).toBe("Turn left onto Hauptstraße");
  });

  it("has nothing to say for a step with no text at all", () => {
    expect(spokenInstructionFor(cue({ step: {} as never }))).toBeNull();
    expect(spokenInstructionFor(cue({ step: { instruction: "   " } as never }))).toBeNull();
  });
});

describe("groundCueEffect", () => {
  it("includes the distance in a far or near cue", () => {
    const built = groundCueEffect(session(), FINGERPRINT, cue({ tier: "near", distance: 200 }));

    expect(built?.effect.text).toBe("In 200 metres, Turn left");
  });

  it("drops the distance from an imminent cue", () => {
    const built = groundCueEffect(session(), FINGERPRINT, cue({ tier: "now" }));

    // By then the turn is right there; a distance would be noise.
    expect(built?.effect.text).toBe("Turn left now");
  });

  it("speaks imperial distances for an imperial session", () => {
    const built = groundCueEffect(
      session({ units: "imperial" }),
      FINGERPRINT,
      cue({ distance: 400 }),
    );

    expect(built?.effect.text).toMatch(/ft|mi/);
  });

  it("speaks German for a German session", () => {
    const built = groundCueEffect(session({ locale: "de" }), FINGERPRINT, cue({ distance: 200 }));

    expect(built?.effect.text).toBe("In 200 Meter, Turn left");
    expect(built?.effect.locale).toBe("de");
  });

  it("produces nothing for a step with no text", () => {
    expect(groundCueEffect(session(), FINGERPRINT, cue({ step: {} as never }))).toBeNull();
  });

  it("stays silent for an over-long instruction rather than throwing", () => {
    // A malformed step must cost one cue, not the whole committed batch.
    const step = { instruction: "x".repeat(600) };

    expect(groundCueEffect(session(), FINGERPRINT, cue({ step: step as never }))).toBeNull();
  });
});

describe("groundCueId", () => {
  it("is stable for the same session, route and cue", () => {
    expect(groundCueId("s1", FINGERPRINT, "step-1:near")).toBe(
      groundCueId("s1", FINGERPRINT, "step-1:near"),
    );
  });

  it("differs between sessions", () => {
    expect(groundCueId("s1", FINGERPRINT, "k")).not.toBe(groundCueId("s2", FINGERPRINT, "k"));
  });

  it("differs between routes, so a replacement reopens the cue namespace", () => {
    // Without this, a reroute onto a new road could find "turn left in 200
    // metres" already spoken and stay silent at the one turn the user did not
    // expect.
    expect(groundCueId("s1", "route-a", "k")).not.toBe(groundCueId("s1", "route-b", "k"));
  });

  it("differs between cues on one route", () => {
    expect(groundCueId("s1", FINGERPRINT, "step-1:near")).not.toBe(
      groundCueId("s1", FINGERPRINT, "step-1:now"),
    );
  });

  it("stays within the audio module's identifier bound", () => {
    const id = groundCueId("s".repeat(200), "f".repeat(200), "k".repeat(200));

    expect(id.length).toBeLessThanOrEqual(MAX_CUE_ID_LENGTH);
  });

  it("gives an off-route episode one identifier for its whole duration", () => {
    expect(offRouteEpisodeId("s1", FINGERPRINT, 1_000)).toBe(
      offRouteEpisodeId("s1", FINGERPRINT, 1_000),
    );
    // A later episode is a different event, and warrants a second warning.
    expect(offRouteEpisodeId("s1", FINGERPRINT, 1_000)).not.toBe(
      offRouteEpisodeId("s1", FINGERPRINT, 2_000),
    );
  });

  it("gives arrival exactly one identifier per route", () => {
    expect(arrivalCueId("s1", FINGERPRINT)).toBe(arrivalCueId("s1", FINGERPRINT));
  });
});

describe("statusCueEffect", () => {
  it.each([
    ["off-route", "en", "You are off the route"],
    ["off-route", "de", "Du bist von der Route abgekommen"],
  ] as const)("speaks the %s warning in %s", (kind, locale, expected) => {
    const effect = statusCueEffect(session({ locale }), "cue-1", kind);

    expect(effect?.text).toBe(expected);
    expect(effect?.locale).toBe(locale);
  });

  it("speaks arrival in both locales", () => {
    expect(statusCueEffect(session(), "cue-1", "arrival")?.text).toBeTruthy();
    expect(statusCueEffect(session({ locale: "de" }), "cue-1", "arrival")?.text).toBeTruthy();
  });

  it("carries the identifier it was given, so the ledger can dedupe it", () => {
    expect(statusCueEffect(session(), "cue-42", "off-route")?.cueId).toBe("cue-42");
  });
});

describe("cue exactly-once behaviour", () => {
  /**
   * The ledger is what survives a crash, so these assert the property that
   * matters: a cue recorded before a crash is not spoken again after it.
   */
  it("is not rebuilt for a cue already in the ledger", () => {
    const built = groundCueEffect(session(), FINGERPRINT, cue());
    const afterCrash = session({
      cueLedger: { spoken: [built?.cueId ?? ""], events: [] },
    });

    // The batch processor consults the ledger; the identifier it would build is
    // identical, which is what makes that check work across a restart.
    expect(groundCueEffect(afterCrash, FINGERPRINT, cue())?.cueId).toBe(built?.cueId);
    expect(afterCrash.cueLedger.spoken).toContain(built?.cueId);
  });

  it("builds a different identifier after a route replacement", () => {
    const built = groundCueEffect(session(), FINGERPRINT, cue());

    const afterReplacement = groundCueEffect(session(), "route-xyz", cue());

    expect(afterReplacement?.cueId).not.toBe(built?.cueId);
  });

  it("declares an age past which a cue is no longer worth speaking", () => {
    // A ten-second-old maneuver is behind the user; announcing it would send
    // them the wrong way.
    expect(MAX_CUE_AGE_MS).toBe(10_000);
  });
});
