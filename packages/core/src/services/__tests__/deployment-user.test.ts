import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// A checkout root owns, for the refusal below.

/** A file's permission bits, read through a descriptor rather than a second lookup by path. */
function permissions(path: string): number {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return fstatSync(descriptor).mode & 0o777;
  } finally {
    closeSync(descriptor);
  }
}

const rootOwned = vi.hoisted(() => ({ path: "" }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    statSync: ((path: string, ...rest: unknown[]) => {
      const stats = (fs.statSync as (...args: unknown[]) => import("node:fs").Stats)(path, ...rest);
      if (rootOwned.path && String(path) === rootOwned.path) {
        return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
          uid: 0,
          gid: 0,
        });
      }
      return stats;
    }) as typeof fs.statSync,
  };
});

const {
  assertRunningAsDeploymentUser,
  DeploymentUserError,
  ensureDeploymentUser,
  readDeploymentUser,
  readDeploymentUserAssignments,
} = await import("../deployment-user");
const { stackComposeArgs } = await import("../deployment");

const roots: string[] = [];
afterEach(() => {
  rootOwned.path = "";
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function checkout() {
  const root = mkdtempSync(join(tmpdir(), "openmapx-deployment-user-"));
  roots.push(root);
  const infraDir = join(root, "infra", "docker");
  mkdirSync(infraDir, { recursive: true });
  const owner = statSync(root);
  return { root, infraDir, env: join(infraDir, ".env"), uid: owner.uid, gid: owner.gid };
}

describe("the deployment's user", () => {
  it("is written from the checkout's owner when .env has none, once", () => {
    const { infraDir, env, uid, gid } = checkout();
    writeFileSync(env, "DOMAIN=maps.example.test\n# UID=1000\n# GID=1000\n", { mode: 0o600 });
    expect(ensureDeploymentUser(infraDir)).toEqual({ uid, gid, derived: ["UID", "GID"] });
    const written = readFileSync(env, "utf8");
    expect(written.startsWith("DOMAIN=maps.example.test\n# UID=1000\n# GID=1000\n")).toBe(true);
    expect(written).toContain(`\nUID=${uid}\nGID=${gid}\n`);
    expect(permissions(env)).toBe(0o600);
    expect(ensureDeploymentUser(infraDir)).toEqual({ uid, gid, derived: [] });
    expect(readFileSync(env, "utf8")).toBe(written);
  });

  it("keeps explicit values, and writes only the one that is missing", () => {
    const { infraDir, env, gid } = checkout();
    writeFileSync(env, "UID=4321\n", { mode: 0o600 });
    expect(ensureDeploymentUser(infraDir)).toEqual({ uid: 4321, gid, derived: ["GID"] });
    expect(readDeploymentUserAssignments(infraDir)).toEqual({ uid: 4321, gid });
    writeFileSync(env, 'export UID="5000"\nGID=5001\n', { mode: 0o600 });
    expect(ensureDeploymentUser(infraDir)).toEqual({ uid: 5000, gid: 5001, derived: [] });
  });

  it("creates a missing .env with just the two, owner-only", () => {
    const { infraDir, env, uid, gid } = checkout();
    expect(ensureDeploymentUser(infraDir).derived).toEqual(["UID", "GID"]);
    expect(readFileSync(env, "utf8")).toMatch(new RegExp(`UID=${uid}\\nGID=${gid}\\n$`));
    expect(permissions(env)).toBe(0o600);
  });

  it("refuses uid 0, a malformed value, and an .env that is not the operator's own", () => {
    const { root, infraDir, env } = checkout();
    rootOwned.path = root;
    expect(() => ensureDeploymentUser(infraDir)).toThrow(/owned by root/);
    rootOwned.path = "";
    writeFileSync(env, "UID=node\n", { mode: 0o600 });
    expect(() => ensureDeploymentUser(infraDir)).toThrow(/numeric id/);
    writeFileSync(env, "DOMAIN=x\n");
    chmodSync(env, 0o664);
    expect(() => ensureDeploymentUser(infraDir)).toThrow(/no group or other write/);
    expect(readFileSync(env, "utf8")).toBe("DOMAIN=x\n");
  });

  it("is only read on the agent's path: .env keeps its bytes, inode and mtime", () => {
    const { infraDir, env, uid, gid } = checkout();
    // Read through one descriptor rather than a second lookup by path.
    const state = () => {
      const descriptor = openSync(env, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stats = fstatSync(descriptor, { bigint: true });
        return {
          bytes: readFileSync(descriptor, "utf8"),
          ino: stats.ino,
          mtimeNs: stats.mtimeNs,
        };
      } finally {
        closeSync(descriptor);
      }
    };
    const written = (contents: string) => {
      writeFileSync(env, contents, { mode: 0o600 });
      utimesSync(env, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
      return state();
    };
    let before = written(`DOMAIN=x\nUID=${uid}\nGID=${gid}\n`);
    expect(readDeploymentUser(infraDir)).toEqual({ uid, gid });
    expect(state()).toEqual(before);
    for (const [contents, missing] of [
      ["DOMAIN=x\n# UID=1000\n", "UID or GID"],
      [`UID=${uid}\n`, "GID"],
      [`GID=${gid}\n`, "UID"],
    ] as const) {
      before = written(contents);
      expect(() => readDeploymentUser(infraDir)).toThrow(DeploymentUserError);
      expect(() => readDeploymentUser(infraDir)).toThrow(
        `infra/docker/.env sets no ${missing}, and the operations agent does not write .env: run \`pnpm openmapx compose render\` on the host`,
      );
      expect(state()).toEqual(before);
    }
    // An .env that is not the operator's own is refused before it is read.
    written(`UID=${uid}\nGID=${gid}\n`);
    chmodSync(env, 0o664);
    expect(() => readDeploymentUser(infraDir)).toThrow(/no group or other write/);
    rmSync(env);
    expect(() => readDeploymentUser(infraDir)).toThrow(/sets no UID or GID/);
    expect(existsSync(env)).toBe(false);
  });

  it("is the only user a render may run as", () => {
    const uid = process.geteuid?.() ?? 0;
    expect(() => assertRunningAsDeploymentUser({ uid })).not.toThrow();
    expect(() => assertRunningAsDeploymentUser({ uid: uid + 1 })).toThrow(
      new RegExp(`runs as uid ${uid}, but the deployment's user .* is ${uid + 1}`),
    );
  });

  it("is .env's for every stack Compose call, whatever this process inherited", () => {
    const { infraDir, env } = checkout();
    writeFileSync(env, "UID=4321\nGID=4322\n", { mode: 0o600 });
    const paths = {
      infraDir,
      composePath: join(infraDir, "docker-compose.generated.yml"),
      composeReleasePath: join(infraDir, "docker-compose.release.yml"),
    };
    const inherited = { UID: process.env.UID, GID: process.env.GID };
    try {
      delete process.env.UID;
      delete process.env.GID;
      expect(stackComposeArgs(paths)).toContain(env);
      process.env.UID = "4321";
      process.env.GID = "4322";
      expect(stackComposeArgs(paths)).toContain(env);
      // Compose would take these over --env-file: refused.
      process.env.UID = "1000";
      expect(() => stackComposeArgs(paths)).toThrow(
        "UID=1000 in this process's environment differs from UID=4321 in infra/docker/.env",
      );
      process.env.UID = "4321";
      process.env.GID = "1000";
      expect(() => stackComposeArgs(paths)).toThrow(/GID=1000 .* differs from GID=4322/);
    } finally {
      for (const [name, value] of Object.entries(inherited)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
