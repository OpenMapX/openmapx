import type { KeyChord, KeySequence } from "./types";

export type { KeyChord, KeySequence };

export type Platform = "mac" | "other";

let cachedPlatform: Platform | null = null;

/** Detect platform once. Falls back to "other" in non-browser environments. */
export function getPlatform(): Platform {
  if (cachedPlatform) return cachedPlatform;
  if (typeof navigator === "undefined") {
    cachedPlatform = "other";
    return cachedPlatform;
  }
  // navigator.platform is deprecated but still the most reliable signal
  // for "is this Cmd-driven". userAgentData is gated behind a feature flag in some browsers.
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform;
  cachedPlatform = /mac|iphone|ipad|ipod/i.test(platform) ? "mac" : "other";
  return cachedPlatform;
}

/** Test seam: reset detection (used in unit tests). */
export function _resetPlatformCacheForTests(): void {
  cachedPlatform = null;
}

/**
 * Parse a shortcut string like "Mod+K", "g s", "?".
 * - "Mod" → cross-platform primary modifier (Cmd on mac, Ctrl elsewhere).
 * - Single space separates chords in a sequence.
 * Throws on empty or trailing-plus strings.
 */
export function parseShortcut(input: string): KeySequence {
  if (!input.trim()) {
    throw new Error(`Invalid shortcut: empty string`);
  }
  const chordStrs = input.trim().split(/\s+/);
  return chordStrs.map((chordStr) => parseChord(chordStr, input));
}

function parseChord(chordStr: string, original: string): KeyChord {
  if (chordStr.endsWith("+")) {
    throw new Error(`Invalid shortcut '${original}': trailing '+' in '${chordStr}'`);
  }
  const parts = chordStr.split("+").map((p) => p.trim());
  if (parts.length === 0 || parts.some((p) => p === "")) {
    throw new Error(`Invalid shortcut '${original}': empty segment in '${chordStr}'`);
  }
  const chord: KeyChord = { key: "" };
  let keySet = false;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "mod") chord.ctrl = true;
    else if (lower === "ctrl" || lower === "control") chord.ctrl = true;
    else if (lower === "shift") chord.shift = true;
    else if (lower === "alt" || lower === "option") chord.alt = true;
    else if (lower === "cmd" || lower === "meta")
      chord.ctrl = true; // collapse to ctrl
    else {
      if (keySet) {
        throw new Error(
          `Invalid shortcut '${original}': multiple non-modifier keys in '${chordStr}'`,
        );
      }
      chord.key = lower;
      keySet = true;
    }
  }
  if (!keySet) {
    throw new Error(`Invalid shortcut '${original}': no key in '${chordStr}'`);
  }
  return chord;
}

/** Render a KeySequence for display. */
export function formatShortcut(seq: KeySequence, platform: Platform = getPlatform()): string {
  return seq.map((c) => formatChord(c, platform)).join(" ");
}

function formatChord(chord: KeyChord, platform: Platform): string {
  const parts: string[] = [];
  // Conventional modifier ordering:
  // - mac (Apple HIG): Control, Option, Shift, Command — left to right
  //   (we don't model Control separately, so emitted order is ⌥⇧⌘).
  // - other (Windows/Linux): Ctrl, Shift, Alt.
  if (platform === "mac") {
    if (chord.alt) parts.push("⌥");
    if (chord.shift) parts.push("⇧");
    if (chord.ctrl) parts.push("⌘");
  } else {
    if (chord.ctrl) parts.push("Ctrl");
    if (chord.shift) parts.push("Shift");
    if (chord.alt) parts.push("Alt");
  }
  const keyDisplay = chord.key.length === 1 ? chord.key.toUpperCase() : capitalize(chord.key);
  parts.push(keyDisplay);
  // On mac the modifier glyphs concatenate without separator; elsewhere we use "+".
  return platform === "mac" ? parts.join("") : parts.join("+");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Minimal shape of a keyboard event needed by matchChord / matchSequence. */
export interface KeyEventLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/** Match a KeyboardEvent (or any KeyEventLike) against a single chord. */
export function matchChord(
  event: KeyEventLike,
  chord: KeyChord,
  platform: Platform = getPlatform(),
): boolean {
  if (event.key.toLowerCase() !== chord.key.toLowerCase()) return false;
  // Mod = metaKey on mac, ctrlKey elsewhere
  const wantCtrl = chord.ctrl ?? false;
  const hasMod = platform === "mac" ? event.metaKey : event.ctrlKey;
  if (wantCtrl !== hasMod) return false;
  // The "other" modifier must NOT be pressed (avoids treating Ctrl+K as Cmd+K on mac)
  const otherMod = platform === "mac" ? event.ctrlKey : event.metaKey;
  if (wantCtrl && otherMod) return false;
  const hasShift = event.shiftKey && !isShiftImplicitInKey(event.key);
  if ((chord.shift ?? false) !== hasShift) return false;
  if ((chord.alt ?? false) !== event.altKey) return false;
  return true;
}

/** Try to advance the running buffer by one event. Returns: */
export type SequenceMatchResult =
  | { kind: "match"; consumed: KeyChord[] }
  | { kind: "partial"; buffered: KeyChord[] }
  | { kind: "miss" };

/**
 * Stateless sequence matcher. Caller maintains the buffer.
 * Given a buffer of past chords + a new event + a list of registered sequences,
 * report whether we hit a complete match, a partial prefix, or no match.
 */
export function matchSequence(
  buffer: KeyChord[],
  event: KeyEventLike,
  sequences: KeySequence[],
  platform: Platform = getPlatform(),
): SequenceMatchResult {
  // Reject candidates carrying the non-primary modifier (Ctrl on mac,
  // Meta on other) — same rule matchChord enforces. Without this, e.g.
  // Ctrl+G on mac would normalise to {key:'g'} and incorrectly advance
  // a "g s" sequence.
  const otherMod = platform === "mac" ? event.ctrlKey : event.metaKey;
  if (otherMod) return { kind: "miss" };

  // Build the "what would the buffer look like with this event?" candidate.
  const candidateChord: KeyChord = {
    key: event.key.toLowerCase(),
    ctrl: platform === "mac" ? event.metaKey : event.ctrlKey,
    shift: event.shiftKey && !isShiftImplicitInKey(event.key),
    alt: event.altKey,
  };
  // Drop falsy modifier flags so equality checks line up with parseShortcut output.
  if (!candidateChord.ctrl) delete candidateChord.ctrl;
  if (!candidateChord.shift) delete candidateChord.shift;
  if (!candidateChord.alt) delete candidateChord.alt;
  const next = [...buffer, candidateChord];

  for (const seq of sequences) {
    if (seq.length < next.length) continue;
    const matchesPrefix = next.every((c, i) => chordsEqual(c, seq[i]));
    if (!matchesPrefix) continue;
    if (seq.length === next.length) return { kind: "match", consumed: next };
    return { kind: "partial", buffered: next };
  }
  return { kind: "miss" };
}

function isShiftImplicitInKey(key: string): boolean {
  return key.length === 1 && key.toLowerCase() === key.toUpperCase();
}

function chordsEqual(a: KeyChord, b: KeyChord): boolean {
  return (
    a.key === b.key &&
    (a.ctrl ?? false) === (b.ctrl ?? false) &&
    (a.shift ?? false) === (b.shift ?? false) &&
    (a.alt ?? false) === (b.alt ?? false)
  );
}
