import type { Locale } from "./locale";

/**
 * First words of a spoken manoeuvre instruction that read correctly after a
 * fronted reference ("At the second traffic light, turn right …", "An der
 * zweiten Ampel rechts abbiegen.").
 *
 * The lists come from Valhalla's verbal alert and pre-transition strings,
 * recorded for en-US and de-DE in `__fixtures__/`. German Valhalla speaks
 * infinitive forms ("Rechts auf … abbiegen."), so its relative directions open
 * most turns; the finite verbs cover other engines and future wording.
 */
const STARTERS: Readonly<Record<Locale, ReadonlySet<string>>> = {
  en: new Set([
    "turn",
    "bear",
    "keep",
    "take",
    "make",
    "continue",
    "go",
    "head",
    "merge",
    "exit",
    "enter",
    "stay",
  ]),
  de: new Set([
    "biegen",
    "halten",
    "nehmen",
    "fahren",
    "wenden",
    "folgen",
    "bleiben",
    "verlassen",
    "wechseln",
    "ordnen",
    "rechts",
    "links",
    "scharf",
    "leicht",
    "geradeaus",
  ]),
};

/**
 * Recorded first words that deliberately take no reference, with the reason.
 * The fixture test fails when a recording yields a word in neither list.
 */
export const REFERENCE_STARTER_EXCLUSIONS: Readonly<
  Record<Locale, Readonly<Record<string, string>>>
> = {
  en: {
    your: "arrival: 'Your destination will be on the right.'",
    you: "arrival: 'You will arrive at your destination.'",
    drive: "departure: 'Drive northeast.'",
  },
  de: {
    das: "arrival: 'Das Ziel befindet sich auf der rechten Seite.'",
    ziel: "arrival: 'Ziel befindet sich auf der rechten Seite.'",
    richtung: "departure: 'Richtung Nordosten fahren.'",
    auf: "departure or continue: 'Auf Warschauer Straße Richtung Süden fahren.'",
    weiter: "continue without a turn: 'Weiter auf A 5.'",
    an: "a second fronted place reads badly: 'An der Ausfahrt 20 abfahren.'",
    aus: "roundabout exit, not a turn: 'Aus dem Kreisverkehr … ausfahren.'",
    nach: "u-turn: 'Nach links eine Kehrtwende … machen.'",
    in: "a second fronted phrase reads badly: 'In Richtung Tiergarten nach links abbiegen.'",
  },
};

/** The instruction's first word, lowercased, without trailing punctuation. */
function firstWord(instruction: string, locale: Locale): string {
  const word = instruction.trim().split(/\s+/, 1)[0] ?? "";
  return word.replace(/[.,:;!?]+$/u, "").toLocaleLowerCase(locale);
}

/** Whether a reference may be fronted onto this instruction. */
export function startsWithReferenceStarter(instruction: string, locale: Locale): boolean {
  return STARTERS[locale]?.has(firstWord(instruction, locale)) ?? false;
}
