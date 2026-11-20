import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectDockerContextSecretViolations,
  enumerateSensitiveIgnoredPathNames,
} from "./check-docker-context-secrets";

// Independent security policy fixture: omitting a required production rule must fail the gate probe.
const REQUIRED_DOCKERIGNORE_RULES = [
  "infra/docker/secrets/",
  "**/.generated-secrets/",
  "**/*.key",
  "**/*.jks",
  "**/*.keystore",
  "**/*.p12",
  "**/*.mobileprovision",
  "**/*.ipa",
  "**/*.aab",
  "**/*.apk",
  "apps/mobile/ios/",
  "apps/mobile/android/",
  "apps/mobile/.expo/",
  "apps/mobile/.gradle/",
] as const;
const RETAINED_RULES = [".env*", "**/.env*", "!.env.example", "*.pem", "**/*.pem"] as const;

let root: string;

function write(relativePath: string, contents = ""): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function actionWorkflow(dockerfile: string): string {
  return [
    "jobs:",
    "  build:",
    "    steps:",
    "      - uses: docker/build-push-action@v6",
    "        with:",
    "          context: .",
    `          file: ${dockerfile}`,
    "",
  ].join("\n");
}

function configureSyntheticRepository(options: { rootRules?: readonly string[] } = {}): void {
  execFileSync("git", ["init", "-q"], { cwd: root });
  const rules = options.rootRules ?? [
    ...REQUIRED_DOCKERIGNORE_RULES,
    ...RETAINED_RULES,
    "scratch/",
  ];
  write(".dockerignore", rules.join("\n"));
  write(
    ".gitignore",
    [...REQUIRED_DOCKERIGNORE_RULES, ...RETAINED_RULES, "scratch/", "node_modules/"].join("\n"),
  );
}

function expose(paths: readonly string[]): void {
  const rules = [
    ...REQUIRED_DOCKERIGNORE_RULES,
    ...RETAINED_RULES,
    "scratch/",
    ...paths.map((path) => `!${path}`),
  ];
  write(".dockerignore", rules.join("\n"));
  for (const path of paths) write(path);
}

function violations(): string[] {
  return collectDockerContextSecretViolations(root);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openmapx-docker-context-policy-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("Docker build-context secret policy", () => {
  it("requires every exact high-risk and retained ignore rule", () => {
    for (const missing of [...REQUIRED_DOCKERIGNORE_RULES, ...RETAINED_RULES]) {
      configureSyntheticRepository({
        rootRules: [...REQUIRED_DOCKERIGNORE_RULES, ...RETAINED_RULES].filter(
          (rule) => rule !== missing,
        ),
      });

      expect(violations().join("\n")).toContain(missing);
      rmSync(join(root, ".git"), { recursive: true, force: true });
    }
  });

  it("rejects a nested PEM when only the root-only retained pattern is present", () => {
    configureSyntheticRepository({
      rootRules: [...REQUIRED_DOCKERIGNORE_RULES, ...RETAINED_RULES].filter(
        (rule) => rule !== "**/*.pem",
      ),
    });
    write("nested/private.pem");

    expect(enumerateSensitiveIgnoredPathNames(root)).toContain("nested/private.pem");
    expect(violations().join("\n")).toContain("nested/private.pem");
  });

  it.each([
    "scratch/secret-backup.txt",
    "scratch/secret_token",
    "scratch/credentials-production.json",
    "scratch/credential.cache",
    ".env-local",
    "nested/.envrc",
    "nested/.env_production",
    ".generated-secrets/arbitrary-token",
    "nested/.generated-secrets/arbitrary-token",
  ])("classifies and rejects an explicitly re-included sensitive name: %s", (path) => {
    configureSyntheticRepository();
    expose([path]);

    expect(enumerateSensitiveIgnoredPathNames(root)).toContain(path);
    expect(violations().join("\n")).toContain(path);
  });

  it.each([
    "scratch/signing.key",
    "scratch/signing.jks",
    "scratch/signing.keystore",
    "scratch/signing.p12",
    "scratch/profile.mobileprovision",
    "scratch/application.ipa",
    "scratch/application.aab",
    "scratch/application.apk",
    "scratch/root.pem",
  ])("rejects a re-included required secret extension: %s", (path) => {
    configureSyntheticRepository();
    expose([path]);

    expect(violations().join("\n")).toContain(path);
  });

  it("allows safe ordinary ignored names without opening their contents", () => {
    configureSyntheticRepository();
    expose(["scratch/cache.bin"]);
    write("src/application.ts", "export {};");

    expect(enumerateSensitiveIgnoredPathNames(root)).not.toContain("scratch/cache.bin");
    expect(violations()).toEqual([]);
  });

  it("classifies a dangling sensitive symlink by name without following it", () => {
    configureSyntheticRepository();
    const link = "scratch/secret-link";
    write(
      ".dockerignore",
      [...REQUIRED_DOCKERIGNORE_RULES, ...RETAINED_RULES, "scratch/", `!${link}`].join("\n"),
    );
    mkdirSync(join(root, "scratch"), { recursive: true });
    symlinkSync("missing-target", join(root, link));

    expect(enumerateSensitiveIgnoredPathNames(root)).toContain(link);
    expect(violations().join("\n")).toContain(link);
  });
});

describe("Docker ignore policies, whatever builds them", () => {
  const complete = [...REQUIRED_DOCKERIGNORE_RULES, ...RETAINED_RULES, "scratch/"];
  const withoutKeyRule = complete.filter((rule) => rule !== "**/*.key");

  /** A repository with a complete root policy and no workflow or Dockerfile. */
  const repository = () => configureSyntheticRepository();

  it.each([
    "Dockerfile.dockerignore",
    "docker/api.Dockerfile.dockerignore",
    "deploy/nested/Containerfile.prod.dockerignore",
  ])("requires every rule in %s although no workflow builds its Dockerfile", (override) => {
    repository();
    write(override.slice(0, -".dockerignore".length), "FROM scratch\nCOPY . /app\n");
    write(override, withoutKeyRule.join("\n"));

    expect(violations()).toContain(`${override} is missing required rule: **/*.key`);
  });

  it.each([
    ["no workflow", undefined],
    ["a build action", actionWorkflow("docker/Hidden.Dockerfile")],
    [
      "a shell build",
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - run: docker build -f docker/Hidden.Dockerfile .",
        "",
      ].join("\n"),
    ],
  ])("requires every rule in an override built by %s", (_name, workflow) => {
    repository();
    if (workflow) write(".github/workflows/docker.yml", workflow);
    write("docker/Hidden.Dockerfile", "FROM scratch\nCOPY . .\n");
    write("docker/Hidden.Dockerfile.dockerignore", "node_modules/\n");

    expect(violations().join("\n")).toContain(
      "docker/Hidden.Dockerfile.dockerignore is missing required rule: infra/docker/secrets/",
    );
  });

  it("requires every rule in an override whose Dockerfile is not in the repository", () => {
    repository();
    write("generated/Dockerfile.dockerignore", withoutKeyRule.join("\n"));

    expect(violations()).toContain(
      "generated/Dockerfile.dockerignore is missing required rule: **/*.key",
    );
  });

  it("requires every rule in an untracked or Git-ignored override", () => {
    repository();
    write("untracked/Dockerfile.dockerignore", withoutKeyRule.join("\n"));
    write("scratch/Dockerfile.dockerignore", withoutKeyRule.join("\n"));

    const result = violations();
    expect(result).toContain(
      "untracked/Dockerfile.dockerignore is missing required rule: **/*.key",
    );
    expect(result).toContain("scratch/Dockerfile.dockerignore is missing required rule: **/*.key");
  });

  it("rejects an override that re-includes a sensitive ignored path", () => {
    repository();
    write(
      "docker/api.Dockerfile.dockerignore",
      [...complete, "!scratch/production-signing.[k]ey"].join("\n"),
    );
    write("scratch/production-signing.key");

    expect(violations()).toEqual([
      "docker/api.Dockerfile.dockerignore does not exclude sensitive ignored path from the Docker context: scratch/production-signing.key",
    ]);
  });

  it("requires every rule in the root file a build from standard input uses", () => {
    repository();
    write(".dockerignore", withoutKeyRule.join("\n"));

    expect(violations()).toEqual([".dockerignore is missing required rule: **/*.key"]);
  });

  // Docker cannot read a directory as an ignore file, so only a symlink could
  // stand in for a policy this check never reads.
  it.each([
    ["a missing file", "missing-ignore"],
    ["a complete policy", "complete.dockerignore-source"],
  ])("fails closed when an override is a symlink to %s", (_name, target) => {
    repository();
    write("docker/complete.dockerignore-source", complete.join("\n"));
    symlinkSync(target, join(root, "docker/api.Dockerfile.dockerignore"));

    expect(violations()).toContain(
      "docker/api.Dockerfile.dockerignore ignore policy is a symlink, not a regular file",
    );
  });

  it.each(["docker/api.Dockerfile", "scratch/Dockerfile", "deploy/Containerfile.prod"])(
    "fails closed when the override next to %s is a directory",
    (dockerfile) => {
      repository();
      write(dockerfile, "FROM scratch\nCOPY . /app\n");
      mkdirSync(join(root, `${dockerfile}.dockerignore`, "nested"), { recursive: true });

      expect(violations()).toContain(
        `${dockerfile}.dockerignore ignore policy is not a regular file`,
      );
    },
  );

  it.each(["docker/api.Dockerfile", "scratch/Dockerfile"])(
    "fails closed when %s is a symlink, since its ignore file is then ambiguous",
    (dockerfile) => {
      repository();
      write(join(dirname(dockerfile), "real.Dockerfile"), "FROM scratch\nCOPY . /app\n");
      symlinkSync("real.Dockerfile", join(root, dockerfile));

      expect(violations()).toContain(`Dockerfile ${dockerfile} is a symlink, not a regular file`);
    },
  );

  it("accepts complete overrides and leaves other contexts and dependencies alone", () => {
    repository();
    write("docker/api.Dockerfile", "FROM scratch\nCOPY . /app\n");
    write("docker/api.Dockerfile.dockerignore", complete.join("\n"));
    write("scratch/production-signing.key");
    // Another build context's own policy and a dependency's files are never a
    // root-context policy or Dockerfile.
    write("docs/.dockerignore", "node_modules/\n");
    write("node_modules/some-package/Dockerfile.dockerignore", "\n");
    write("node_modules/some-package/real.Dockerfile");
    symlinkSync("real.Dockerfile", join(root, "node_modules/some-package/Dockerfile"));

    expect(violations()).toEqual([]);
  });
});
