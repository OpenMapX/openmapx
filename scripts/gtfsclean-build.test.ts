import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const buildScript = resolve(root, "services/motis/tools/transitous/build-gtfsclean.sh");
const temporaryDirectories: string[] = [];

function fakeToolchain() {
  const directory = mkdtempSync(join(tmpdir(), "openmapx-gtfsclean-build-"));
  temporaryDirectories.push(directory);
  const bin = join(directory, "bin");
  const state = join(directory, "state");
  const calls = join(directory, "calls.log");
  mkdirSync(bin);
  mkdirSync(state);
  const go = join(bin, "go");
  writeFileSync(
    go,
    `#!/bin/sh
set -eu
printf '%s|%s\\n' "\${GOPROXY:-}" "$*" >> "$CALL_LOG"
case "$*" in
  "get github.com/public-transport/gtfsclean@"*) key=gtfsclean; fail_until=2 ;;
  "get golang.org/x/text@"*) key=text; fail_until=1 ;;
  *) exit 0 ;;
esac
count_file="$STATE_DIR/$key"
count=0
if [ -f "$count_file" ]; then count=$(cat "$count_file"); fi
count=$((count + 1))
printf '%s\\n' "$count" > "$count_file"
if [ "\${ALWAYS_FAIL:-}" = "$key" ] || [ "$count" -le "$fail_until" ]; then exit 75; fi
`,
  );
  chmodSync(go, 0o755);
  const sleep = join(bin, "sleep");
  writeFileSync(sleep, "#!/bin/sh\nexit 0\n");
  chmodSync(sleep, 0o755);
  return {
    calls,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CALL_LOG: calls,
      STATE_DIR: state,
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("pinned gtfsclean build", () => {
  it("retries transient module fetches and preserves the reviewed pins", () => {
    expect(existsSync(buildScript)).toBe(true);
    if (!existsSync(buildScript)) return;
    const toolchain = fakeToolchain();

    execFileSync("sh", [buildScript], {
      env: toolchain.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const calls = readFileSync(toolchain.calls, "utf8").trim().split("\n");
    expect(
      calls.filter((call) =>
        call.endsWith(
          "get github.com/public-transport/gtfsclean@013af793337b759e782c3f8919e0b535cb702944",
        ),
      ),
    ).toHaveLength(3);
    expect(calls.filter((call) => call.endsWith("get golang.org/x/text@v0.43.0"))).toHaveLength(2);
    expect(calls.at(-1)).toBe(
      "direct|build -trimpath -o /usr/local/bin/gtfsclean github.com/public-transport/gtfsclean",
    );
  });

  it("stops after four failed fetch attempts", () => {
    expect(existsSync(buildScript)).toBe(true);
    if (!existsSync(buildScript)) return;
    const toolchain = fakeToolchain();

    const result = spawnSync("sh", [buildScript], {
      env: { ...toolchain.env, ALWAYS_FAIL: "gtfsclean" },
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    const calls = readFileSync(toolchain.calls, "utf8").trim().split("\n");
    expect(
      calls.filter((call) => call.includes("get github.com/public-transport/gtfsclean@")),
    ).toHaveLength(4);
    expect(calls.some((call) => call.includes("build -trimpath"))).toBe(false);
  });
});
