import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Mobility-core owns lower-level domain types. Core may depend on it, while
// integration-framework and integrations remain above core. These tests keep
// the upper layers from leaking back into core.

const SRC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      out.push(full);
    }
  }
  return out;
}

function offendersFor(needle: string): string[] {
  const offenders: string[] = [];
  for (const file of collectSourceFiles(SRC_DIR)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (line.includes(needle)) offenders.push(`${file}:${i + 1}`);
    });
  }
  return offenders;
}

describe("core import boundaries", () => {
  it("does not import from any @integrations/* package", () => {
    // Build the needle by concatenation so this test file itself is not a match.
    const needle = `from "${"@integrations/"}`;
    const offenders = offendersFor(needle);
    expect(
      offenders,
      `core must not import from @integrations/*:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("does not import from @openmapx/integration-framework", () => {
    const needle = `from "${"@openmapx/integration-framework"}"`;
    const offenders = offendersFor(needle);
    expect(
      offenders,
      `core must not import from @openmapx/integration-framework:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
