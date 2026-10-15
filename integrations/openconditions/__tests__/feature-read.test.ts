import { describe, expect, test } from "vitest";
import type { OpenConditionsClient } from "../client.js";
import { readFeaturePages } from "../features/read.js";

type Rec = Record<string, unknown>;

/** A client whose every `/features` read answers `page`. */
const answering = (page: Rec): OpenConditionsClient => ({
  baseUrl: "http://openconditions.test:4100",
  get: async <T>() => page as T,
  getOptional: async <T>() => page as T,
});

const partialOf = async (coverage: Rec | undefined) => {
  const page: Rec = { records: [], ...(coverage !== undefined ? { coverage } : {}) };
  const pages = readFeaturePages(answering(page), {
    bbox: [8, 49, 8.1, 49.1],
    kind: "camera",
    expand: "components,latest",
    pageSize: 100,
    maxBytes: 1_000_000,
    max: 400,
  });
  const read: boolean[] = [];
  for await (const p of pages) read.push(p.partial);
  return read;
};

describe("the shared feature reader's coverage", () => {
  test("a source missing its configuration is no gap: zooming in or waiting never helps it", async () => {
    const missing = { id: "windy-cameras", complete: false, reason: "missing_configuration" };
    expect(await partialOf({ partial: false, sources: [missing] })).toEqual([false]);
    // Without the summary flag the entries decide, by the same rule.
    expect(await partialOf({ sources: [missing] })).toEqual([false]);
  });

  test("a source that could answer and fell short makes the page partial", async () => {
    const missing = { id: "windy-cameras", complete: false, reason: "missing_configuration" };
    const limited = { id: "osm-cameras", complete: false, reason: "limited" };
    expect(await partialOf({ partial: true, sources: [missing, limited] })).toEqual([true]);
    expect(await partialOf({ sources: [missing, limited] })).toEqual([true]);
    expect(await partialOf(undefined)).toEqual([false]);
  });
});
