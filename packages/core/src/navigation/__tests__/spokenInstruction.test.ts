import { describe, expect, it } from "vitest";
import type { RouteStep } from "../../types/routing";
import { spokenInstructionFor } from "../spokenInstruction";

const cases = [
  {
    name: "all fields",
    step: {
      instruction: "Written",
      verbalAlert: "Alert",
      verbalPre: "Pre",
      verbalSuccinct: "Succinct",
      verbalPost: "Post",
    },
    advance: "Alert",
    now: "Pre",
  },
  {
    name: "no alert",
    step: { instruction: "Written", verbalPre: "Pre", verbalSuccinct: "Succinct" },
    advance: "Pre",
    now: "Pre",
  },
  {
    name: "no pre-transition",
    step: { instruction: "Written", verbalAlert: "Alert", verbalSuccinct: "Succinct" },
    advance: "Alert",
    now: "Written",
  },
  { name: "written only", step: { instruction: "Written" }, advance: "Written", now: "Written" },
  {
    name: "blank alert",
    step: { instruction: "Written", verbalAlert: "  ", verbalPre: " Pre " },
    advance: "Pre",
    now: "Pre",
  },
  {
    name: "malformed alert and pre-transition",
    step: { instruction: " Written ", verbalAlert: 42, verbalPre: [] },
    advance: "Written",
    now: "Written",
  },
  {
    name: "null verbal fields",
    step: { instruction: "Written", verbalAlert: null, verbalPre: null },
    advance: "Written",
    now: "Written",
  },
  {
    name: "no written text but usable verbal text",
    step: { instruction: "", verbalAlert: " Alert ", verbalPre: " Pre " },
    advance: "Alert",
    now: "Pre",
  },
  {
    name: "unusable fields",
    step: { instruction: "  ", verbalAlert: false, verbalPre: {} },
    advance: null,
    now: null,
  },
  { name: "missing fields", step: {}, advance: null, now: null },
  {
    name: "only post-transition and succinct text",
    step: { instruction: "", verbalPost: "Post", verbalSuccinct: "Succinct" },
    advance: null,
    now: null,
  },
];

describe("spokenInstructionFor", () => {
  describe.each(["far", "near", "now"] as const)("%s cues", (tier) => {
    it.each(cases)("chooses usable phase-specific text for $name", ({ step, advance, now }) => {
      const before = { ...step };
      expect(spokenInstructionFor({ tier, step: step as RouteStep })).toBe(
        tier === "now" ? now : advance,
      );
      expect(step).toEqual(before);
    });
  });
});
