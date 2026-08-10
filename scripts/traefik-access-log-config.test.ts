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
