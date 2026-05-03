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
  it("matches shifted punctuation by the produced key", () => {
    const result = matchSequence(
      [],
      {
        key: "?",
        ctrlKey: false,
        metaKey: false,
        shiftKey: true,
        altKey: false,
      },
      [parseShortcut("?")],
      "mac",
    );
    expect(result.kind).toBe("match");
  });
});
