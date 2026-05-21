import { describe, expect, it } from "vitest";
import {
  formatShortcut,
  type KeyChord,
  type KeyEventLike,
  matchChord,
  matchSequence,
  parseShortcut,
} from "./keybindings";

describe("parseShortcut", () => {
  it("parses a single bare key", () => {
    expect(parseShortcut("?")).toEqual([{ key: "?" }]);
    expect(parseShortcut("/")).toEqual([{ key: "/" }]);
    expect(parseShortcut("t")).toEqual([{ key: "t" }]);
  });

  it("parses a Mod combo", () => {
    expect(parseShortcut("Mod+K")).toEqual([{ key: "k", ctrl: true }]);
  });

  it("parses Mod+Shift combos", () => {
    expect(parseShortcut("Mod+Shift+K")).toEqual([{ key: "k", ctrl: true, shift: true }]);
  });

  it("parses a two-step sequence", () => {
    expect(parseShortcut("g s")).toEqual([{ key: "g" }, { key: "s" }]);
  });

  it("normalizes case", () => {
    expect(parseShortcut("MOD+k")).toEqual([{ key: "k", ctrl: true }]);
  });

  it("throws on unknown shortcut strings", () => {
    expect(() => parseShortcut("")).toThrow();
    expect(() => parseShortcut("Mod+")).toThrow();
  });

  it("throws on multiple non-modifier keys in one chord", () => {
    expect(() => parseShortcut("Ctrl+K+L")).toThrow();
    expect(() => parseShortcut("a+b")).toThrow();
  });
});

describe("formatShortcut", () => {
  it("renders Mod as ⌘ on mac", () => {
    expect(formatShortcut(parseShortcut("Mod+K"), "mac")).toBe("⌘K");
  });

  it("renders Mod as Ctrl elsewhere", () => {
    expect(formatShortcut(parseShortcut("Mod+K"), "other")).toBe("Ctrl+K");
  });

  it("renders bare keys uppercased", () => {
    expect(formatShortcut(parseShortcut("?"), "mac")).toBe("?");
    expect(formatShortcut(parseShortcut("t"), "mac")).toBe("T");
  });

  it("renders sequences space-separated", () => {
    expect(formatShortcut(parseShortcut("g s"), "mac")).toBe("G S");
  });

  it("renders shift+letter as ⇧K on mac", () => {
    expect(formatShortcut(parseShortcut("Mod+Shift+K"), "mac")).toBe("⇧⌘K");
  });

  it("uses Ctrl+Shift+K ordering on non-mac", () => {
    // Regression: previously rendered "Shift+Ctrl+K" because Shift used
    // unshift while Ctrl used push.
    expect(formatShortcut(parseShortcut("Mod+Shift+K"), "other")).toBe("Ctrl+Shift+K");
  });

  it("uses Ctrl+Shift+Alt+K ordering on non-mac with all modifiers", () => {
    expect(formatShortcut(parseShortcut("Mod+Shift+Alt+K"), "other")).toBe("Ctrl+Shift+Alt+K");
  });
});

describe("matchChord", () => {
  function evt(
    key: string,
    opts: Partial<{ ctrl: boolean; meta: boolean; shift: boolean; alt: boolean }> = {},
  ): KeyEventLike {
    return {
      key,
      ctrlKey: opts.ctrl ?? false,
      metaKey: opts.meta ?? false,
      shiftKey: opts.shift ?? false,
      altKey: opts.alt ?? false,
    };
  }

  const target: KeyChord = { key: "k", ctrl: true };

  it("matches Ctrl+K on non-mac", () => {
    expect(matchChord(evt("k", { ctrl: true }), target, "other")).toBe(true);
  });

  it("matches Cmd+K on mac", () => {
    expect(matchChord(evt("k", { meta: true }), target, "mac")).toBe(true);
  });

  it("does NOT match plain k", () => {
    expect(matchChord(evt("k"), target, "other")).toBe(false);
  });

  it("does NOT match Ctrl+Shift+K when shift is not in target", () => {
    expect(matchChord(evt("k", { ctrl: true, shift: true }), target, "other")).toBe(false);
  });

  it("matches plain key bindings", () => {
    expect(matchChord(evt("?"), { key: "?" }, "mac")).toBe(true);
    expect(matchChord(evt("?", { shift: true }), { key: "?" }, "mac")).toBe(true);
    expect(matchChord(evt("g"), { key: "g" }, "mac")).toBe(true);
  });

  it("does NOT ignore shift for letters", () => {
    expect(matchChord(evt("G", { shift: true }), { key: "g" }, "mac")).toBe(false);
  });
});

describe("matchSequence", () => {
  function evt(
    key: string,
    opts: Partial<{ ctrl: boolean; meta: boolean; shift: boolean; alt: boolean }> = {},
  ): KeyEventLike {
    return {
      key,
      ctrlKey: opts.ctrl ?? false,
      metaKey: opts.meta ?? false,
      shiftKey: opts.shift ?? false,
      altKey: opts.alt ?? false,
    };
  }

  it("matches shifted punctuation by the produced key", () => {
    const result = matchSequence([], evt("?", { shift: true }), [parseShortcut("?")], "mac");
    expect(result.kind).toBe("match");
  });

  it("does NOT match plain `g s` when Ctrl is held on mac", () => {
    // Regression: Ctrl+G on mac would previously normalize to {key:'g'} and
    // advance the buffer, then a plain 's' would complete a "g s" match.
    const sequences = [parseShortcut("g s")];
    const first = matchSequence([], evt("g", { ctrl: true }), sequences, "mac");
    expect(first.kind).toBe("miss");
  });

  it("does NOT match plain `g s` when Meta is held on non-mac", () => {
    const sequences = [parseShortcut("g s")];
    const first = matchSequence([], evt("g", { meta: true }), sequences, "other");
    expect(first.kind).toBe("miss");
  });

  it("returns matchedIndex of the matched sequence", () => {
    const sequences = [parseShortcut("g s"), parseShortcut("g d"), parseShortcut("g n")];
    const partial = matchSequence([], evt("g"), sequences, "mac");
    expect(partial.kind).toBe("partial");
    if (partial.kind !== "partial") return;
    const final = matchSequence(partial.buffered, evt("d"), sequences, "mac");
    expect(final.kind).toBe("match");
    if (final.kind !== "match") return;
    expect(final.matchedIndex).toBe(1);
  });
});
