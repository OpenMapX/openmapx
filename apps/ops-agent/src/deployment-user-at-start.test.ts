import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeDeploymentUserAtStart } from "./deployment-user-at-start";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stack() {
  const root = mkdtempSync(join(tmpdir(), "openmapx-agent-user-"));
  roots.push(root);
  const infraDir = join(root, "infra", "docker");
  mkdirSync(infraDir, { recursive: true });
  return { infraDir, env: join(infraDir, ".env") };
}

/** `.env` with an old mtime, so a write in the same instant would still show. */
function written(path: string, contents: string) {
  writeFileSync(path, contents, { mode: 0o600 });
  utimesSync(path, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
  return envFileState(path);
}

/** Read through one descriptor rather than a second lookup by path. */
function envFileState(path: string) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(descriptor, { bigint: true });
    return {
      bytes: readFileSync(descriptor, "utf8"),
      ino: stats.ino,
      mtimeNs: stats.mtimeNs,
      mode: stats.mode,
    };
  } finally {
    closeSync(descriptor);
  }
}

const uid = process.geteuid?.() ?? 0;
const gid = process.getegid?.() ?? 0;

describe("the deployment's user when the agent starts", () => {
  it("is read from .env, which stays as it was", () => {
    const { infraDir, env } = stack();
    const before = written(env, `DOMAIN=maps.example.test\nUID=${uid}\nGID=${gid}\n`);
    expect(describeDeploymentUserAtStart(infraDir)).toEqual([]);
    expect(envFileState(env)).toEqual(before);
  });

  it("is reported, not written, when .env lacks UID or GID, and the agent starts anyway", () => {
    const { infraDir, env } = stack();
    for (const [contents, missing] of [
      ["DOMAIN=maps.example.test\n# UID=1000\n# GID=1000\n", "UID or GID"],
      [`DOMAIN=maps.example.test\nGID=${gid}\n`, "UID"],
    ] as const) {
      const before = written(env, contents);
      expect(describeDeploymentUserAtStart(infraDir)).toEqual([
        `infra/docker/.env sets no ${missing}, and the operations agent does not write .env: run \`pnpm openmapx compose render\` on the host, as the checkout's owner, which writes UID and GID from that owner.`,
      ]);
      expect(envFileState(env)).toEqual(before);
    }
  });

  it("does not create a missing .env", () => {
    const { infraDir, env } = stack();
    expect(describeDeploymentUserAtStart(infraDir)).toEqual([
      expect.stringContaining("sets no UID or GID"),
    ]);
    expect(existsSync(env)).toBe(false);
  });

  it("reports a deployment's user the agent does not run as", () => {
    const { infraDir, env } = stack();
    const before = written(env, `UID=${uid + 1}\nGID=${gid}\n`);
    expect(describeDeploymentUserAtStart(infraDir)).toEqual([
      expect.stringMatching(/^The operations agent runs as uid \d+, but the deployment's user/),
    ]);
    expect(envFileState(env)).toEqual(before);
  });
});
