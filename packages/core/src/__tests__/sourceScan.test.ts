import { describe, expect, it } from "vitest";
import { codeOnly } from "./support/sourceScan";

// biome-ignore lint/suspicious/noTemplateCurlyInString: source text handed to the scanner.
const EXPRESSION = "${call()}";

describe("codeOnly", () => {
  it("blanks comments and literal text but keeps code inside template expressions", () => {
    const source = [
      "/** call() in a doc comment */",
      'const a = "call()"; // call() after code',
      "const b = /call\\(\\)/;",
      `const c = \`call() ${EXPRESSION} call()\`;`,
      "const d = <p>call()</p>;",
    ].join("\n");
    const code = codeOnly(source);

    expect(code).toHaveLength(source.length);
    expect(code.split("\n")).toHaveLength(5);
    expect([...code.matchAll(/\bcall\(\)/g)].map((match) => match.index)).toEqual([
      source.indexOf(EXPRESSION) + 2,
    ]);
    expect(code).toContain("const a =");
    expect(code).toContain("const d = <p>");
  });
});
