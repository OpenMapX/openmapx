import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = readFileSync(
  new URL("../services/traefik/config/traefik.yml", import.meta.url),
  "utf8",
);

function topLevelSection(name: string): string {
  const match = config.match(
    new RegExp(`^${name}:\\n(?<body>(?:^[ \\t].*(?:\\n|$)|^\\s*$)*)`, "m"),
  );
  if (!match?.groups?.body) throw new Error(`Missing ${name} section`);
  return match.groups.body;
}

describe("Traefik access-log privacy", () => {
  it("keeps useful operational fields without retaining paths, lines, or query parameters", () => {
    const accessLog = topLevelSection("accessLog");

    expect(accessLog).toContain("  format: json");
    expect(accessLog).toContain("  fields:\n    defaultMode: drop");
    expect(accessLog).toContain("      RequestMethod: keep");
    expect(accessLog).toContain("      RouterName: keep");
    expect(accessLog).toContain("      DownstreamStatus: keep");
    expect(accessLog).toContain("      Duration: keep");
    expect(accessLog).toContain("    queryParameters:\n      defaultMode: drop");
    expect(accessLog).not.toMatch(/Request(?:Path|Line):\s*keep/);
  });
});

describe("Traefik encoded path characters", () => {
  it("lets encoded ids through the https entrypoint while refusing NUL and backslash", () => {
    const websecure = config.slice(
      config.indexOf("\n  websecure:\n"),
      config.indexOf("\ncertificatesResolvers:"),
    );

    expect(websecure).toContain("      encodedCharacters:\n");
    expect(websecure).toContain("        allowEncodedSlash: true");
    expect(websecure).toContain("        allowEncodedPercent: true");
    expect(websecure).toContain("        allowEncodedHash: true");
    expect(websecure).toContain("        allowEncodedQuestionMark: true");
    expect(websecure).toContain("        allowEncodedSemicolon: true");
    expect(websecure).toContain("        allowEncodedBackSlash: false");
    expect(websecure).toContain("        allowEncodedNullCharacter: false");
  });
});
