import {
  chmodSync,
  chownSync,
  lchownSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { describe, expect, it, vi } from "vitest";
import {
  buildProbeArgs,
  composeNetworkName,
  DEEP_PROBES,
  deploymentStateErrors,
  deploymentUserProblems,
  dockerComposeAfterDeploymentSecretCheck,
  envFilePermissionWarning,
  PROBE_IMAGE,
  probeFailureDetail,
} from "../src/commands/check";

describe("check deployment-secret preflight", () => {
  it("rejects before invoking Docker", async () => {
    const docker = vi.fn();

    await expect(
      dockerComposeAfterDeploymentSecretCheck(["ps"], {
        env: {
          POSTGRES_PASSWORD: "change-me",
          BETTER_AUTH_SECRET: "a".repeat(32),
          DATA_MANAGER_AUTH_TOKEN: "b".repeat(32),
        },
        dockerCompose: docker,
      }),
    ).rejects.toThrow(/known-placeholder/);
    expect(docker).not.toHaveBeenCalled();
  });

  it("continues to Docker for a valid fake deployment value", async () => {
    const result = { stdout: "", stderr: "", exitCode: 0 };
    const docker = vi.fn().mockResolvedValue(result);

    await expect(
      dockerComposeAfterDeploymentSecretCheck(["ps"], {
        env: {
          POSTGRES_PASSWORD: "x".repeat(24),
          POSTGRES_USER: "postgres",
          BETTER_AUTH_SECRET: "a".repeat(32),
          DATA_MANAGER_AUTH_TOKEN: "b".repeat(32),
        },
        dockerCompose: docker,
      }),
    ).resolves.toEqual(result);
    expect(docker).toHaveBeenCalledOnce();
  });

  it.each(["BETTER_AUTH_SECRET", "DATA_MANAGER_AUTH_TOKEN"] as const)(
    "rejects a weak %s before invoking Docker",
    async (name) => {
      const docker = vi.fn();
      const env = {
        POSTGRES_PASSWORD: "x".repeat(24),
        BETTER_AUTH_SECRET: "a".repeat(32),
        DATA_MANAGER_AUTH_TOKEN: "b".repeat(32),
        [name]: "short",
      };

      await expect(
        dockerComposeAfterDeploymentSecretCheck(["ps"], { env, dockerCompose: docker }),
      ).rejects.toThrow(new RegExp(`${name}.*too-short`));
      expect(docker).not.toHaveBeenCalled();
    },
  );
});

describe("buildProbeArgs", () => {
  it("builds args for a standalone `docker run` curl container on the compose network", () => {
    const args = buildProbeArgs("docker_openmapx", "http://valhalla:8002/status");

    // `--network` is rejected by `docker compose run` (cobra: "unknown flag:
    // --network"), so the probe must run via plain `docker run`, which accepts
    // it. The network name is passed straight through.
    const netIdx = args.indexOf("--network");
    expect(netIdx).toBeGreaterThanOrEqual(0);
    expect(args[netIdx + 1]).toBe("docker_openmapx");
  });

  it("uses a real, pinned curl image", () => {
    const args = buildProbeArgs("docker_openmapx", "http://app-api:3001/health");
    // The old `alpine/wget:1.27.0` image does not exist on Docker Hub.
    expect(PROBE_IMAGE).toMatch(/^curlimages\/curl:\d+\.\d+\.\d+$/);
    expect(args).toContain(PROBE_IMAGE);
  });

  it("does not pass docker-compose-only flags to `docker run`", () => {
    const args = buildProbeArgs("docker_openmapx", "http://app-api:3001/health");
    // `--no-deps` is a `docker compose run` flag; `docker run` errors on it.
    expect(args).not.toContain("--no-deps");
  });

  it("auto-removes the container and targets the probe url last", () => {
    const url = "http://photon:2322/api?q=test";
    const args = buildProbeArgs("docker_openmapx", url);
    expect(args).toContain("--rm");
    expect(args[args.length - 1]).toBe(url);
  });
});

describe("composeNetworkName", () => {
  it("uses the explicit network name from this checkout's compose config", () => {
    expect(
      composeNetworkName(
        JSON.stringify({
          name: "docker",
          networks: { openmapx: { name: "production_openmapx" } },
        }),
      ),
    ).toBe("production_openmapx");
  });

  it("falls back to the project-derived network name", () => {
    expect(composeNetworkName(JSON.stringify({ name: "docker", networks: {} }))).toBe(
      "docker_openmapx",
    );
    expect(composeNetworkName("not json")).toBeNull();
  });
});

describe("probeFailureDetail", () => {
  it("keeps the actionable Docker error instead of the generic help footer", () => {
    expect(
      probeFailureDetail(
        "docker: Error response from daemon: network deploy_openmapx not found.\n\nRun 'docker run --help' for more information",
        125,
      ),
    ).toBe("docker: Error response from daemon: network deploy_openmapx not found.");
  });

  it("falls back to the exit code when stderr is empty", () => {
    expect(probeFailureDetail("", 125)).toBe("exit 125");
  });
});

describe("envFilePermissionWarning", () => {
  it("warns when the env file is readable beyond its owner", () => {
    expect(envFilePermissionWarning("infra/docker/.env", 0o644)).toContain("chmod 600");
  });

  it("accepts owner-only read/write permissions", () => {
    expect(envFilePermissionWarning("infra/docker/.env", 0o600)).toBeNull();
    expect(envFilePermissionWarning("infra/docker/.env", 0o400)).toBeNull();
  });

  it("warns for group-readable permissions", () => {
    expect(envFilePermissionWarning("infra/docker/.env", 0o660)).toContain("mode 0660");
  });

  it("ignores an absent env file", () => {
    expect(envFilePermissionWarning("infra/docker/.env", null)).toBeNull();
  });
});

describe("DEEP_PROBES", () => {
  it("bounds the overpass query with an explicit timeout", () => {
    // A timeout-less Overpass query reaped under load can orphan its
    // query-hash-keyed shm segment, after which that exact string returns
    // `duplicate_query` forever (`%5Btimeout%3A` is the URL-encoded `[timeout:`).
    const overpass = DEEP_PROBES.overpass;
    expect(overpass).not.toBeNull();
    expect(overpass?.path).toContain("%5Btimeout%3A");
    expect(overpass?.expect).toBe("elements");
  });
});

describe("deploymentStateErrors", () => {
  it("reports an unsafe .env and a held release selection", async () => {
    const infraDir = mkdtempSync(join(tmpdir(), "openmapx-check-state-"));
    try {
      expect(deploymentStateErrors(infraDir)).toEqual([]);
      writeFileSync(join(infraDir, ".env"), "DOMAIN=example.test\n", { mode: 0o600 });
      chmodSync(join(infraDir, ".env"), 0o664);
      writeFileSync(
        services.legacyReleaseStatePaths(infraDir).overlay,
        "services:\n  app-api:\n    image: hand-edited\n",
        { mode: 0o600 },
      );
      mkdirSync(join(infraDir, "state", "ops-agent"), { recursive: true, mode: 0o700 });
      await services.migrateLegacyReleaseState(infraDir);
      const errors = deploymentStateErrors(infraDir);
      expect(errors).toHaveLength(2);
      expect(errors[0]).toContain("no group or other write");
      expect(errors[1]).toContain("pnpm openmapx compose release");
    } finally {
      rmSync(infraDir, { recursive: true, force: true });
    }
  });
});

/** Directories and files by path with their owner; a directory lists the paths below it. */
function fakeFilesystem(owners: Record<string, number>, children: Record<string, string[]> = {}) {
  return {
    lstat(path: string) {
      const uid = owners[path];
      if (uid === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return {
        uid,
        isDirectory: () => path in children,
        isSymbolicLink: () => false,
      };
    },
    readdir: (path: string) => children[path] ?? [],
  };
}

describe("deploymentUserProblems", () => {
  function deployment(env: string | null) {
    const root = mkdtempSync(join(tmpdir(), "openmapx-check-user-"));
    const infraDir = join(root, "infra", "docker");
    mkdirSync(infraDir, { recursive: true });
    if (env !== null) writeFileSync(join(infraDir, ".env"), env, { mode: 0o600 });
    return { root, infraDir, owner: statSync(root) };
  }

  it("says the next render writes a missing UID/GID from the checkout's owner", () => {
    const { root, infraDir, owner } = deployment("DOMAIN=x\n");
    try {
      expect(
        deploymentUserProblems({
          infraDir,
          processUid: owner.uid,
          composeServices: null,
          runningUsers: new Map(),
        }),
      ).toEqual([expect.stringContaining(`uid ${owner.uid}, gid ${owner.gid}`)]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports .env, the checkout, this process, containers and paths that disagree", () => {
    const { root, infraDir, owner } = deployment("UID=4321\nGID=4321\n");
    try {
      const problems = deploymentUserProblems({
        infraDir,
        processUid: owner.uid,
        composeServices: {
          "app-api": {
            user: "4321:4321",
            volumes: [
              { type: "bind", source: join(infraDir, "state", "ops-agent", "trusted-config") },
              { type: "bind", source: join(infraDir, "data", "erasure") },
              // Read-only: Docker may have created it as root, and that is fine.
              { type: "bind", source: join(infraDir, "data", "motis", "live"), read_only: true },
              { type: "volume", source: "openmapx-subject-exports" },
            ],
          },
          "ops-agent": { user: "4321:4321", volumes: [] },
          postgis: { volumes: [{ type: "bind", source: join(infraDir, "data", "postgis") }] },
        },
        runningUsers: new Map([
          ["app-api", ""],
          ["ops-agent", "4321:4321"],
          ["postgis", ""],
        ]),
        filesystem: fakeFilesystem({
          [join(infraDir, "state", "ops-agent", "trusted-config")]: 1000,
          [join(infraDir, "data", "erasure")]: 4321,
        }),
      });
      expect(problems).toEqual([
        expect.stringContaining(
          `UID in infra/docker/.env is 4321, but the checkout belongs to uid ${owner.uid}`,
        ),
        expect.stringContaining(
          `This check runs as uid ${owner.uid}, not as the deployment's user (UID=4321)`,
        ),
        expect.stringContaining('app-api runs as its image\'s default user, not "4321:4321"'),
        expect.stringMatching(
          new RegExp(
            `state/ops-agent/trusted-config \\(uid 1000\\).*sudo chown -R 4321:4321 ${join(infraDir, "state", "ops-agent", "trusted-config")}$`,
          ),
        ),
      ]);
      // postgis runs as its image's own user: neither its user nor its data is compared.
      expect(problems.join("\n")).not.toContain("postgis");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds a file another uid wrote inside a directory the deployment's user owns", () => {
    const { root, infraDir, owner } = deployment("");
    try {
      writeFileSync(join(infraDir, ".env"), `UID=${owner.uid}\nGID=${owner.gid}\n`, {
        mode: 0o600,
      });
      const mount = join(infraDir, "data", "erasure");
      const user = `${owner.uid}:${owner.gid}`;
      const problems = deploymentUserProblems({
        infraDir,
        processUid: owner.uid,
        composeServices: { "app-api": { user, volumes: [{ type: "bind", source: mount }] } },
        runningUsers: new Map([["app-api", user]]),
        // An earlier release's container wrote the journal as uid 1000.
        filesystem: fakeFilesystem(
          {
            [mount]: owner.uid,
            [join(mount, "nested")]: owner.uid,
            [join(mount, "nested", "journal.jsonl")]: 1000,
          },
          { [mount]: ["nested"], [join(mount, "nested")]: ["journal.jsonl"] },
        ),
      });
      expect(problems).toEqual([
        expect.stringContaining(`data/erasure (nested/journal.jsonl: uid 1000)`),
      ]);
      expect(problems[0]).toContain(`sudo chown -R ${owner.uid}:${owner.gid} ${mount}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("says so when it stops before walking every mount", () => {
    const { root, infraDir, owner } = deployment("");
    try {
      writeFileSync(join(infraDir, ".env"), `UID=${owner.uid}\nGID=${owner.gid}\n`, {
        mode: 0o600,
      });
      const mount = join(infraDir, "data", "erasure");
      const user = `${owner.uid}:${owner.gid}`;
      const owners: Record<string, number> = { [mount]: owner.uid };
      const names = Array.from({ length: 10 }, (_, index) => `file-${index}`);
      for (const name of names) owners[join(mount, name)] = owner.uid;
      expect(
        deploymentUserProblems({
          infraDir,
          processUid: owner.uid,
          composeServices: { "app-api": { user, volumes: [{ type: "bind", source: mount }] } },
          runningUsers: new Map([["app-api", user]]),
          filesystem: fakeFilesystem(owners, { [mount]: names }),
          entryLimit: 5,
        }),
      ).toEqual([
        expect.stringContaining(
          "Stopped checking ownership after 5 entries; not fully checked: data/erasure",
        ),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.getuid?.() === 0)(
    "finds a 1000-owned file in a 1001-owned directory on the real filesystem, without following links",
    () => {
      const { root, infraDir } = deployment("UID=1001\nGID=1001\n");
      try {
        chownSync(root, 1001, 1001);
        chownSync(join(infraDir, ".env"), 0, 0);
        const mount = join(infraDir, "data", "erasure");
        mkdirSync(join(mount, "nested"), { recursive: true });
        writeFileSync(join(mount, "nested", "journal.jsonl"), "{}\n");
        chownSync(mount, 1001, 1001);
        chownSync(join(mount, "nested"), 1001, 1001);
        chownSync(join(mount, "nested", "journal.jsonl"), 1000, 1000);
        // A link to a directory another uid owns is not entered.
        mkdirSync(join(root, "elsewhere"));
        symlinkSync(join(root, "elsewhere"), join(mount, "link"));
        lchownSync(join(mount, "link"), 1001, 1001);
        const problems = deploymentUserProblems({
          infraDir,
          processUid: 1001,
          composeServices: {
            "app-api": { user: "1001:1001", volumes: [{ type: "bind", source: mount }] },
          },
          runningUsers: new Map([["app-api", "1001:1001"]]),
        });
        expect(problems).toEqual([
          expect.stringContaining("data/erasure (nested/journal.jsonl: uid 1000)"),
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("is quiet when everything is the deployment's user", () => {
    const { root, infraDir, owner: checkoutOwner } = deployment("");
    try {
      writeFileSync(
        join(infraDir, ".env"),
        `UID=${checkoutOwner.uid}\nGID=${checkoutOwner.gid}\n`,
        { mode: 0o600 },
      );
      const user = `${checkoutOwner.uid}:${checkoutOwner.gid}`;
      expect(
        deploymentUserProblems({
          infraDir,
          processUid: checkoutOwner.uid,
          composeServices: { "app-api": { user, volumes: [] } },
          runningUsers: new Map([["app-api", user]]),
        }),
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
