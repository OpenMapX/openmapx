import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("Dependabot compatibility boundaries", () => {
  it("does not update TypeScript majors or React Native independently of their stacks", () => {
    const config = readFileSync(resolve(root, ".github/dependabot.yml"), "utf8");
    const npmRoot = config.slice(
      config.indexOf("  - package-ecosystem: npm"),
      config.indexOf("  # The documentation site"),
    );

    expect(npmRoot).toMatch(
      /- dependency-name: "typescript"\n\s+update-types: \["version-update:semver-major"\]/,
    );
    expect(npmRoot).toMatch(/- dependency-name: "react-native"(?:\n|$)/);
  });
});
