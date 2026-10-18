import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { rootContextDockerfiles } from "../check-docker-context-secrets.ts";

// Fixed scanner inputs only: the parent supplies an owned temporary repository.
// Never evaluate workflow text in a shell. A parent deadline bounds the scanner.
const root = process.argv[2];
assert.ok(root);
const workflow = join(root, ".github/workflows/docker.yml");
function scan(redirection: string): Set<string> {
  writeFileSync(
    workflow,
    [
      "jobs:",
      "  build:",
      "    steps:",
      "      - run: |",
      `          { true; } ${redirection}`,
      "          docker build --file docker/Hidden.Dockerfile .",
    ].join("\n"),
  );
  return rootContextDockerfiles(root);
}

// Many finite redirects must be consumed completely, without a length cutoff.
assert.deepEqual(scan(">12345678".repeat(4096)), new Set(["docker/Hidden.Dockerfile"]));
process.stdout.write("finite redirects accepted\n");
// An invalid tail forces the former matcher to reconsider target/fd boundaries.
assert.throws(() => scan(`${">12345678".repeat(128)}!`), /structural separator/);
process.stdout.write("malformed redirects rejected\n");
