import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = resolve(import.meta.dirname, "await-registry-digest.sh");
const ref = "example.invalid/openmapx/release-manifest:main";
const expected = `sha256:${"9".repeat(64)}`;
const stale = `sha256:${"7".repeat(64)}`;

let temp: string;

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "openmapx-await-digest-"));
  // The fake answers each `imagetools inspect` from the next queue line; FAIL fails that read.
  const docker = join(temp, "docker");
  writeFileSync(
    docker,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CALLS"
reads=$(wc -l < "$CALLS")
answer=$(sed -n "\${reads}p" "$QUEUE")
[ -n "$answer" ] || answer=$(tail -n 1 "$QUEUE")
if [ "$answer" = FAIL ]; then echo "registry unavailable" >&2; exit 1; fi
echo "$answer"
`,
  );
  chmodSync(docker, 0o755);
});

afterEach(() => rmSync(temp, { recursive: true, force: true }));

function run(answers: string[]) {
  writeFileSync(join(temp, "queue"), `${answers.join("\n")}\n`);
  const result = spawnSync("bash", [script, ref, expected], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${temp}:${process.env.PATH}`,
      CALLS: join(temp, "calls"),
      QUEUE: join(temp, "queue"),
      AWAIT_REGISTRY_DIGEST_DELAY_SECONDS: "0",
    },
  });
  const calls = readFileSync(join(temp, "calls"), "utf8").trim().split("\n");
  return { ...result, calls };
}

describe("await-registry-digest", () => {
  it("waits through stale reads until the tag shows the expected digest", () => {
    const { status, calls, stderr } = run([stale, stale, expected]);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toBe(`buildx imagetools inspect ${ref} --format {{.Manifest.Digest}}`);
  });

  it("fails with both digests when the tag never shows the expected digest", () => {
    const { status, calls, stderr } = run([stale]);
    expect(status).toBe(1);
    expect(calls).toHaveLength(12);
    expect(stderr).toContain(ref);
    expect(stderr).toContain(expected);
    expect(stderr).toContain(stale);
  });

  it("treats a failing read as stale until the registry answers", () => {
    const { status, calls } = run(["FAIL", expected]);
    expect(status).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it("rejects a call without a reference and a digest", () => {
    const result = spawnSync("bash", [script, ref], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage");
  });
});
