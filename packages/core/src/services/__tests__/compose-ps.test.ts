import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ComposePsFormatError, parseComposePsJson } from "../compose-ps";

// Captured verbatim from `docker compose ps --format json` against one stack
// (see __fixtures__/compose-ps/README.md): Compose 2.20.3 prints an array,
// 2.21.0 and later one object per line.
function captured(name: string): string {
  return readFileSync(new URL(`./__fixtures__/compose-ps/${name}`, import.meta.url), "utf8");
}

function summary(stdout: string) {
  return parseComposePsJson(stdout).map((entry) => [entry.Service, entry.State]);
}

const PROBE_STACK = [
  ["crashloop", "restarting"],
  ["web", "running"],
  ["worker", "paused"],
];

describe("parseComposePsJson", () => {
  it.each([["compose-5.6.1.stdout"], ["compose-2.21.0.stdout"], ["compose-2.20.3.stdout"]])(
    "reads every container Compose printed in %s",
    (name) => {
      expect(summary(captured(name))).toEqual(PROBE_STACK);
    },
  );

  it("holds line-delimited output that one JSON.parse of the whole refuses", () => {
    expect(() => JSON.parse(captured("compose-5.6.1.stdout"))).toThrow(SyntaxError);
  });

  it.each([
    ["compose-5.6.1-empty.stdout", ""],
    ["compose-2.20.3-empty.stdout", "[]\n"],
  ])("reads the empty stack in %s as no containers", (name, expected) => {
    const stdout = captured(name);
    expect(stdout).toBe(expected);
    expect(parseComposePsJson(stdout)).toEqual([]);
  });

  it("accepts CRLF line endings and blank lines", () => {
    expect(summary('{"Service":"web","State":"running"}\r\n\r\n{"Service":"db"}\r\n')).toEqual([
      ["web", "running"],
      ["db", undefined],
    ]);
  });

  it.each([
    ["a line that is not JSON", '{"Service":"web"}\nnot json\n', /line 2 is not JSON/],
    ["pretty-printed JSON", '[\n  {"Service":"web"}\n]\n', /line 1 is not JSON/],
    ["a truncated line", '{"Service":"web"}\n{"Service":"d', /line 2 is not JSON/],
    ["a scalar", '"web"\n', /line 1 holds something other than containers/],
    ["null", "null\n", /line 1 holds something other than containers/],
    ["a nested array", "[[]]\n", /line 1 holds something other than containers/],
    ["an array holding a scalar", '[{"Service":"web"},3]\n', /line 1 holds something other/],
  ])("refuses %s", (_label, stdout, message) => {
    expect(() => parseComposePsJson(stdout)).toThrow(ComposePsFormatError);
    expect(() => parseComposePsJson(stdout)).toThrow(message);
  });
});
