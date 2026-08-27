import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectDockerContextSecretViolations,
  dockerIgnoreExcludes,
  enumerateSensitiveIgnoredPathNames,
  REQUIRED_DOCKERIGNORE_RULES,
  rootContextDockerfiles,
} from "./check-docker-context-secrets";

const RETAINED_RULES = [".env*", "**/.env*", "!.env.example", "*.pem", "**/*.pem"] as const;
const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface ReferenceMatcher {
  add(rules: string[]): ReferenceMatcher;
  ignores(path: string): boolean;
}

const requireFromTest = createRequire(import.meta.url);
const createReferenceMatcher = requireFromTest(
  join(
    WORKSPACE_ROOT,
    "node_modules/.pnpm/@balena+dockerignore@1.0.2/node_modules/@balena/dockerignore/ignore.js",
  ),
) as (options: { ignorecase: boolean }) => ReferenceMatcher;
let root: string;

function write(relativePath: string, contents = ""): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function actionWorkflow(
  dockerfile = "Dockerfile",
  options: { fileFirst?: boolean; usesLast?: boolean } = {},
): string {
  const withLines = options.fileFirst
    ? [`          file: ${dockerfile}`, "          context: ."]
    : ["          context: .", `          file: ${dockerfile}`];
  const actionLines = options.usesLast
    ? ["        with:", ...withLines, "        uses: docker/build-push-action@v6"]
    : ["        uses: docker/build-push-action@v6", "        with:", ...withLines];
  return ["jobs:", "  build:", "    steps:", "      - name: Build", ...actionLines, ""].join("\n");
}

function githubExpression(value: string): string {
  return ["$", `{{ ${value} }}`].join("");
}

function bracedShellVariable(value: string): string {
  return ["$", `{${value}}`].join("");
}

interface NativeLegacyResult {
  dockerArgs?: string[];
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

function legacyBacktickCommand(
  openingBackslashes: number,
  innerCommand: string,
  closingBackslashes = openingBackslashes,
): string {
  const tick = "`";
  return `echo ${tick}echo ${"\\".repeat(openingBackslashes)}${tick}${innerCommand}${"\\".repeat(closingBackslashes)}${tick}${tick}`;
}

function legacyModernSubstitutionCommand(backslashes: number, innerCommand: string): string {
  const tick = "`";
  return `echo ${tick}echo ${"\\".repeat(backslashes)}$(${innerCommand})${tick}`;
}

function doubleLegacyModernSubstitutionCommand(backslashes: number, innerCommand: string): string {
  const tick = "`";
  return `echo ${tick}echo \\${tick}echo ${"\\".repeat(backslashes)}$(${innerCommand})\\${tick}${tick}`;
}

function nativeLegacyResult(command: string): NativeLegacyResult {
  const markerStart = "__OPENMAPX_DOCKER_ARGV_BEGIN__";
  const markerEnd = "__OPENMAPX_DOCKER_ARGV_END__";
  const harness = [
    "exec 3>&1",
    "docker() {",
    `  printf "${markerStart}\\n" >&3`,
    '  printf "%s\\n" "$@" >&3',
    `  printf "${markerEnd}\\n" >&3`,
    "}",
    "export -f docker",
    'eval "$1"',
  ].join("\n");
  const result = spawnSync("bash", ["-c", harness, "track12-cycle10", command], {
    encoding: "utf8",
  });
  const captured = result.stdout.match(
    new RegExp(`${markerStart}\\n([\\s\\S]*?)${markerEnd}`, "u"),
  )?.[1];
  return {
    dockerArgs: captured === undefined ? undefined : captured.trimEnd().split("\n"),
    exitCode: result.status,
    stderr: result.stderr,
    stdout: result.stdout
      .replace(new RegExp(`${markerStart}\\n[\\s\\S]*?${markerEnd}\\n?`, "u"), "")
      .trim(),
  };
}

function configureSyntheticRepository(
  options: { dockerfile?: string; rootRules?: readonly string[]; workflow?: string } = {},
): void {
  execFileSync("git", ["init", "-q"], { cwd: root });
  const rules = options.rootRules ?? [
    ...REQUIRED_DOCKERIGNORE_RULES,
    ...RETAINED_RULES,
    "scratch/",
  ];
  write(".dockerignore", rules.join("\n"));
  write(".gitignore", [...REQUIRED_DOCKERIGNORE_RULES, ...RETAINED_RULES, "scratch/"].join("\n"));
  write(".github/workflows/docker.yml", options.workflow ?? actionWorkflow());
  write("Dockerfile", options.dockerfile ?? "FROM scratch\nCOPY . /app\n");
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

function configureHiddenRootBuild(workflow: string): void {
  configureSyntheticRepository({ workflow });
  write("docker/Hidden.Dockerfile", "FROM scratch\nCOPY . .\n");
  write("docker/Hidden.Dockerfile.dockerignore", "node_modules/\n");
}

function outputBuildWorkflow(script: readonly string[]): string {
  return [
    "jobs:",
    "  production:",
    "    steps:",
    "      - id: resolve",
    "        run: |",
    ...script.map((line) => `          ${line}`),
    "      - uses: docker/build-push-action@v6",
    "        with:",
    `          context: ${githubExpression("steps.resolve.outputs.target_context")}`,
    `          file: ${githubExpression("steps.resolve.outputs.target_file")}`,
  ].join("\n");
}

function expectHiddenRootPolicyViolation(script: readonly string[]): void {
  configureHiddenRootBuild(outputBuildWorkflow(script));

  expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
  expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openmapx-docker-context-policy-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("Docker ignore matching", () => {
  it("uses ordered last-match semantics for directory exclusions and re-inclusions", () => {
    const rules = ["private/", "!private/public.txt", "private/public.txt"];

    expect(dockerIgnoreExcludes("private/token.txt", rules)).toBe(true);
    expect(dockerIgnoreExcludes("private/public.txt", rules)).toBe(true);
    expect(dockerIgnoreExcludes("private/other/public.txt", rules)).toBe(true);
    expect(dockerIgnoreExcludes("ordinary.txt", rules)).toBe(false);
    expect(dockerIgnoreExcludes("private/public.txt", rules.slice(0, 2))).toBe(false);
  });

  it("anchors bare patterns at the context root while preserving directory and ** semantics", () => {
    const rules = [
      "/root-only.key",
      "cache/",
      "token?.key",
      "**/deep/*.p12",
      "signing-[0-9].jks",
      "credential-[^x].json",
    ];

    expect(dockerIgnoreExcludes("root-only.key", rules)).toBe(true);
    expect(dockerIgnoreExcludes("nested/root-only.key", rules)).toBe(false);
    expect(dockerIgnoreExcludes("cache/item", rules)).toBe(true);
    expect(dockerIgnoreExcludes("nested/cache/item", rules)).toBe(false);
    expect(dockerIgnoreExcludes("token1.key", rules)).toBe(true);
    expect(dockerIgnoreExcludes("nested/token1.key", rules)).toBe(false);
    expect(dockerIgnoreExcludes("one/deep/mobile.p12", rules)).toBe(true);
    expect(dockerIgnoreExcludes("signing-7.jks", rules)).toBe(true);
    expect(dockerIgnoreExcludes("nested/signing-7.jks", rules)).toBe(false);
    expect(dockerIgnoreExcludes("credential-a.json", rules)).toBe(true);
    expect(dockerIgnoreExcludes("credential-x.json", rules)).toBe(false);
  });

  it("uses Go character-class negation and POSIX backslash escape semantics", () => {
    expect(dockerIgnoreExcludes("aze", ["a[^b-d]e"])).toBe(true);
    expect(dockerIgnoreExcludes("ace", ["a[^b-d]e"])).toBe(false);
    expect(dockerIgnoreExcludes("a!e", ["a[!x]e"])).toBe(true);
    expect(dockerIgnoreExcludes("aae", ["a[!x]e"])).toBe(false);
    expect(dockerIgnoreExcludes("literal[prod].key", ["literal\\[prod\\].key"])).toBe(true);
  });

  it("normalizes dot segments without treating POSIX pattern escapes as separators", () => {
    const rules = ["nested/secrets/", "literal\\[prod\\].key"];

    expect(dockerIgnoreExcludes("nested/other/../secrets/token", rules)).toBe(true);
    expect(dockerIgnoreExcludes(String.raw`nested\secrets\token`, rules)).toBe(false);
    expect(dockerIgnoreExcludes("literal[prod].key", rules)).toBe(true);
  });

  it("fails closed for invalid patterns and candidate paths outside the context", () => {
    expect(() => dockerIgnoreExcludes("secret.key", ["secret["])).toThrow(/invalid/i);
    expect(() => dockerIgnoreExcludes("secret.key", ["secret\\"])).toThrow(/invalid/i);
    expect(() => dockerIgnoreExcludes("../secret.key", ["**/*.key"])).toThrow(/outside|unsafe/i);
    expect(() => dockerIgnoreExcludes("/secret.key", ["**/*.key"])).toThrow(/absolute|unsafe/i);
  });

  it.each([
    [["*.pem"], "private.pem"],
    [["*.pem"], "nested/private.pem"],
    [["**/*.pem"], "private.pem"],
    [["**/*.pem"], "nested/private.pem"],
    [["temp?"], "tempa"],
    [["temp?"], "nested/tempa"],
    [["a[b-d]e"], "ace"],
    [["a[b-d]e"], "aze"],
    [["a[^b-d]e"], "aze"],
    [["a[!x]e"], "a!e"],
    [["a[!x]e"], "aae"],
    [["literal\\[prod\\].key"], "literal[prod].key"],
    [["**/foo/bar"], "foo/bar"],
    [["**/foo/bar"], "nested/foo/bar"],
    [["private/", "!private/public.txt"], "private/public.txt"],
    [["private/", "!private/public.txt", "private/public.txt"], "private/public.txt"],
  ])("matches the installed Docker-compatible reference for %j against %s", (rules, path) => {
    const reference = createReferenceMatcher({ ignorecase: false }).add(rules);

    expect(dockerIgnoreExcludes(path, rules)).toBe(reference.ignores(path));
  });

  it.each([
    [".env*", ".env.production", "nested/.env.production", false],
    ["**/.env*", ".env.production", "nested/.env.production", true],
    ["*.pem", "private.pem", "nested/private.pem", false],
    ["**/*.pem", "private.pem", "nested/private.pem", true],
    [
      "infra/docker/secrets/",
      "infra/docker/secrets/token",
      "nested/infra/docker/secrets/token",
      false,
    ],
    ["**/.generated-secrets/", ".generated-secrets/token", "nested/.generated-secrets/token", true],
    ["**/*.key", "signing.key", "nested/signing.key", true],
    ["**/*.jks", "signing.jks", "nested/signing.jks", true],
    ["**/*.keystore", "signing.keystore", "nested/signing.keystore", true],
    ["**/*.p12", "signing.p12", "nested/signing.p12", true],
    ["**/*.mobileprovision", "signing.mobileprovision", "nested/signing.mobileprovision", true],
    ["**/*.ipa", "application.ipa", "nested/application.ipa", true],
    ["**/*.aab", "application.aab", "nested/application.aab", true],
    ["**/*.apk", "application.apk", "nested/application.apk", true],
    ["apps/mobile/ios/", "apps/mobile/ios/key", "nested/apps/mobile/ios/key", false],
    ["apps/mobile/android/", "apps/mobile/android/key", "nested/apps/mobile/android/key", false],
    ["apps/mobile/.expo/", "apps/mobile/.expo/key", "nested/apps/mobile/.expo/key", false],
    ["apps/mobile/.gradle/", "apps/mobile/.gradle/key", "nested/apps/mobile/.gradle/key", false],
  ])(
    "applies root and nested scope for policy rule %s",
    (rule, rootPath, nestedPath, nestedExcluded) => {
      expect(dockerIgnoreExcludes(rootPath, [rule])).toBe(true);
      expect(dockerIgnoreExcludes(nestedPath, [rule])).toBe(nestedExcluded);
    },
  );

  it("honors the retained root environment example re-inclusion after the root environment rule", () => {
    expect(dockerIgnoreExcludes(".env.example", [".env*", "!.env.example"])).toBe(false);
    expect(dockerIgnoreExcludes(".env.production", [".env*", "!.env.example"])).toBe(true);
  });
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

describe("production root-context Dockerfile discovery", () => {
  it.each([
    ["file after context", actionWorkflow("docker/api.Dockerfile")],
    ["file before context", actionWorkflow("docker/api.Dockerfile", { fileFirst: true })],
    ["uses after with", actionWorkflow("docker/api.Dockerfile", { usesLast: true })],
  ])("discovers a direct action mapping with %s", (_name, workflow) => {
    configureSyntheticRepository({ workflow });

    expect(rootContextDockerfiles(root)).toEqual(new Set(["docker/api.Dockerfile"]));
  });

  it("discovers root matrix entries independent of key order", () => {
    configureSyntheticRepository({
      workflow: [
        "jobs:",
        "  build:",
        "    strategy:",
        "      matrix:",
        "        include:",
        "          - dockerfile: docker/api.Dockerfile",
        "            name: api",
        "            context: .",
        "          - context: .",
        "            name: web",
        "            dockerfile: docker/web.Dockerfile",
        "    steps:",
        "      - uses: docker/build-push-action@v6",
        "        with:",
        `          context: ${githubExpression("matrix.context")}`,
        `          file: ${githubExpression("matrix.dockerfile")}`,
      ].join("\n"),
    });

    expect(rootContextDockerfiles(root)).toEqual(
      new Set(["docker/api.Dockerfile", "docker/web.Dockerfile"]),
    );
  });

  it("discovers shell docker build/buildx forms and continuations", () => {
    configureSyntheticRepository({
      workflow: [
        "jobs:",
        "  build:",
        "    steps:",
        "      - run: docker build --file docker/a.Dockerfile .",
        "      - run: docker buildx build . -f docker/b.Dockerfile",
        "      - run: |",
        "          docker buildx build \\",
        "            --file=docker/c.Dockerfile \\",
        "            .",
      ].join("\n"),
    });

    expect(rootContextDockerfiles(root)).toEqual(
      new Set(["docker/a.Dockerfile", "docker/b.Dockerfile", "docker/c.Dockerfile"]),
    );
  });

  it("discovers case-arm context and Dockerfile outputs used by the build action", () => {
    configureSyntheticRepository({
      workflow: [
        "jobs:",
        "  build:",
        "    steps:",
        "      - id: resolve",
        "        run: |",
        '          case "$SERVICE" in',
        "            api)",
        '              echo "context=." >> "$GITHUB_OUTPUT"',
        '              echo "dockerfile=docker/api.Dockerfile" >> "$GITHUB_OUTPUT"',
        "              ;;",
        "            *) exit 1 ;;",
        "          esac",
        "      - uses: docker/build-push-action@v6",
        "        with:",
        `          file: ${githubExpression("steps.resolve.outputs.dockerfile")}`,
        `          context: ${githubExpression("steps.resolve.outputs.context")}`,
      ].join("\n"),
    });

    expect(rootContextDockerfiles(root)).toEqual(new Set(["docker/api.Dockerfile"]));
  });

  it("discovers multiple output writes on a compact case arm", () => {
    configureSyntheticRepository({
      workflow: [
        "jobs:",
        "  build:",
        "    steps:",
        "      - id: resolve",
        "        run: |",
        '          case "$SERVICE" in',
        '            api) echo "target_context=." >> "$GITHUB_OUTPUT"; echo "target_file=docker/api.Dockerfile" >> "$GITHUB_OUTPUT" ;;',
        "            *) exit 1 ;;",
        "          esac",
        "      - uses: docker/build-push-action@v6",
        "        with:",
        `          file: ${githubExpression("steps.resolve.outputs.target_file")}`,
        `          context: ${githubExpression("steps.resolve.outputs.target_context")}`,
      ].join("\n"),
    });

    expect(rootContextDockerfiles(root)).toEqual(new Set(["docker/api.Dockerfile"]));
  });

  it("discovers a root Docker build command inside a multiline case arm", () => {
    configureHiddenRootBuild(
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - run: |",
        '          case "$SERVICE" in',
        "            api)",
        "              docker build --file docker/Hidden.Dockerfile .",
        "              ;;",
        "            *) exit 1 ;;",
        "          esac",
      ].join("\n"),
    );

    expect(rootContextDockerfiles(root)).toEqual(new Set(["docker/Hidden.Dockerfile"]));
    expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
  });

  it("discovers a root Docker build command after a compact case pattern", () => {
    configureHiddenRootBuild(
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - run: |",
        '          case "$SERVICE" in',
        "            api) docker build --file docker/Hidden.Dockerfile . ;;",
        "            *) exit 1 ;;",
        "          esac",
      ].join("\n"),
    );

    expect(rootContextDockerfiles(root)).toEqual(new Set(["docker/Hidden.Dockerfile"]));
    expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
  });

  it("discovers builds in nested case arms and after case terminators", () => {
    const dockerfiles = [
      "docker/nested.Dockerfile",
      "docker/fallthrough.Dockerfile",
      "docker/retest.Dockerfile",
      "docker/after.Dockerfile",
    ];
    configureSyntheticRepository({
      workflow: [
        "jobs:",
        "  build:",
        "    steps:",
        "      - run: |",
        '          case "$OUTER" in',
        "            nested)",
        '              case "$INNER" in',
        "                root)",
        "                  docker build --file docker/nested.Dockerfile .",
        "                  ;;",
        "              esac",
        "              ;;",
        "            fall) echo fallthrough ;&",
        "            next) docker build --file docker/fallthrough.Dockerfile . ;;",
        "            retest) echo retest ;;&",
        "            *) docker build --file docker/retest.Dockerfile . ;;",
        "          esac",
        "          docker build --file docker/after.Dockerfile .",
      ].join("\n"),
    });
    for (const dockerfile of dockerfiles) {
      write(dockerfile, "FROM scratch\nCOPY . .\n");
      write(`${dockerfile}.dockerignore`, "node_modules/\n");
    }

    expect(rootContextDockerfiles(root)).toEqual(new Set(dockerfiles));
    const result = violations().join("\n");
    for (const dockerfile of dockerfiles) expect(result).toContain(`${dockerfile}.dockerignore`);
  });

  it("lets unconditional exact outputs after esac override every case-arm record", () => {
    configureHiddenRootBuild(
      [
        "jobs:",
        "  production:",
        "    steps:",
        "      - id: resolve",
        "        run: |",
        '          case "$SERVICE" in',
        '            docs) echo "target_context=services/docs" >> "$GITHUB_OUTPUT"; echo "target_file=docs/Dockerfile" >> "$GITHUB_OUTPUT" ;;',
        "            *) exit 1 ;;",
        "          esac",
        '          echo "target_context=." >> "$GITHUB_OUTPUT"',
        '          echo "target_file=docker/Hidden.Dockerfile" >> "$GITHUB_OUTPUT"',
        "      - uses: docker/build-push-action@v6",
        "        with:",
        `          context: ${githubExpression("steps.resolve.outputs.target_context")}`,
        `          file: ${githubExpression("steps.resolve.outputs.target_file")}`,
      ].join("\n"),
    );

    expect(rootContextDockerfiles(root)).toEqual(new Set(["docker/Hidden.Dockerfile"]));
    expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
  });

  it("preserves branch-local outputs across ;& and ;;& fallthrough", () => {
    configureHiddenRootBuild(
      [
        "jobs:",
        "  production:",
        "    steps:",
        "      - id: resolve",
        "        run: |",
        '          echo "target_context=services/docs" >> "$GITHUB_OUTPUT"',
        '          case "$SERVICE" in',
        '            root) echo "target_context=." >> "$GITHUB_OUTPUT" ;&',
        '            file) echo "target_file=docker/Hidden.Dockerfile" >> "$GITHUB_OUTPUT" ;;',
        '            retest) echo "target_context=." >> "$GITHUB_OUTPUT" ;;&',
        '            *) echo "target_file=docker/Hidden.Dockerfile" >> "$GITHUB_OUTPUT" ;;',
        "          esac",
        "      - uses: docker/build-push-action@v6",
        "        with:",
        `          context: ${githubExpression("steps.resolve.outputs.target_context")}`,
        `          file: ${githubExpression("steps.resolve.outputs.target_file")}`,
      ].join("\n"),
    );

    expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
    expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
  });

  it.each([
    ["exit 0", "exit 0"],
    ["bare exit after a successful write", "exit"],
    ["return 0", "return 0"],
  ])("preserves outputs before successful producer termination: %s", (_name, termination) => {
    expectHiddenRootPolicyViolation([
      'echo "target_context=." >> "$GITHUB_OUTPUT"',
      'echo "target_file=docker/Hidden.Dockerfile" >> "$GITHUB_OUTPUT"',
      termination,
      'echo "target_context=services/docs" >> "$GITHUB_OUTPUT"',
      'echo "target_file=docs/Dockerfile" >> "$GITHUB_OUTPUT"',
    ]);
  });

  it("bubbles a successful exit out of a case arm without discarding its outputs", () => {
    expectHiddenRootPolicyViolation([
      'case "$SERVICE" in',
      '  api) echo "target_context=." >> "$GITHUB_OUTPUT"; echo "target_file=docker/Hidden.Dockerfile" >> "$GITHUB_OUTPUT"; exit 0 ;;',
      '  *) echo "target_context=services/docs" >> "$GITHUB_OUTPUT"; echo "target_file=docs/Dockerfile" >> "$GITHUB_OUTPUT" ;;',
      "esac",
    ]);
  });

  it.each([
    ["exit 1", "exit 1"],
    ["return 1", "return 1"],
  ])(
    "does not run a later build action after failed producer termination: %s",
    (_name, termination) => {
      configureHiddenRootBuild(
        outputBuildWorkflow([
          'echo "target_context=." >> "$GITHUB_OUTPUT"',
          'echo "target_file=docker/Hidden.Dockerfile" >> "$GITHUB_OUTPUT"',
          termination,
        ]),
      );

      expect(rootContextDockerfiles(root)).toEqual(new Set());
      expect(violations()).toEqual([]);
    },
  );

  it.each(['exit "$STATUS"', 'return "$STATUS"'])(
    "fails closed for a dynamic producer termination status: %s",
    (termination) => {
      configureHiddenRootBuild(
        outputBuildWorkflow([
          'echo "target_context=." >> "$GITHUB_OUTPUT"',
          'echo "target_file=docker/Hidden.Dockerfile" >> "$GITHUB_OUTPUT"',
          termination,
        ]),
      );

      expect(violations().join("\n")).toMatch(/dynamic|status|unsupported|ambiguous/i);
    },
  );

  it("fails closed when an output branch depends on an unknown command status", () => {
    configureHiddenRootBuild(
      outputBuildWorkflow([
        'echo "target_context=." >> "$GITHUB_OUTPUT"',
        'echo "target_file=docker/Hidden.Dockerfile" >> "$GITHUB_OUTPUT"',
        'probe-service && echo "target_context=services/docs" >> "$GITHUB_OUTPUT"',
      ]),
    );

    expect(violations().join("\n")).toMatch(/unknown.*status|ambiguous|unsupported/i);
  });

  it.each([
    [
      "successful OR skips safe-looking overwrites",
      [
        'true || echo "target_context=services/docs" >> "$GITHUB_OUTPUT"',
        'true || echo "target_file=docs/Dockerfile" >> "$GITHUB_OUTPUT"',
      ],
    ],
    [
      "failed AND skips safe-looking overwrites",
      [
        'false && echo "target_context=services/docs" >> "$GITHUB_OUTPUT"',
        'false && echo "target_file=docs/Dockerfile" >> "$GITHUB_OUTPUT"',
        "true",
      ],
    ],
    [
      "mixed AND/OR lists keep left-associative skipped writes isolated",
      [
        'false && echo "target_context=services/docs" >> "$GITHUB_OUTPUT" || true',
        'true || echo "target_file=docs/Dockerfile" >> "$GITHUB_OUTPUT" && true',
      ],
    ],
    [
      "negated false makes an OR overwrite unreachable",
      ['! false || echo "target_context=services/docs" >> "$GITHUB_OUTPUT"'],
    ],
    [
      "negated true makes an AND overwrite unreachable",
      ['! true && echo "target_file=docs/Dockerfile" >> "$GITHUB_OUTPUT"', "true"],
    ],
  ])("models output writes on AND/OR lists: %s", (_name, commands) => {
    expectHiddenRootPolicyViolation([
      'echo "target_context=." >> "$GITHUB_OUTPUT"',
      'echo "target_file=docker/Hidden.Dockerfile" >> "$GITHUB_OUTPUT"',
      ...commands,
    ]);
  });

  it.each([
    ["successful AND", 'true && echo "target_file=docker/Hidden.Dockerfile" >> "$GITHUB_OUTPUT"'],
    ["failed OR", 'false || echo "target_file=docker/Hidden.Dockerfile" >> "$GITHUB_OUTPUT"'],
  ])("executes reachable output writes on an AND/OR list: %s", (_name, fileWrite) => {
    expectHiddenRootPolicyViolation(['echo "target_context=." >> "$GITHUB_OUTPUT"', fileWrite]);
  });

  it("models AND/OR status and successful termination inside groups and case arms", () => {
    expectHiddenRootPolicyViolation([
      "{",
      '  echo "target_context=." >> "$GITHUB_OUTPUT"',
      '  true || echo "target_context=services/docs" >> "$GITHUB_OUTPUT"',
      "}",
      'case "$SERVICE" in',
      '  api) { false || echo "target_file=docker/Hidden.Dockerfile" >> "$GITHUB_OUTPUT"; exit 0; } ;;',
      "  *) return 1 ;;",
      "esac",
    ]);
  });

  it("skips every output write in a failed gated group", () => {
    expectHiddenRootPolicyViolation([
      'echo "target_context=." >> "$GITHUB_OUTPUT"',
      'echo "target_file=docker/Hidden.Dockerfile" >> "$GITHUB_OUTPUT"',
      "false && {",
      '  echo "target_context=services/docs" >> "$GITHUB_OUTPUT"',
      '  echo "target_file=docs/Dockerfile" >> "$GITHUB_OUTPUT"',
      "} || true",
    ]);
  });

  it("fails closed instead of approximating errexit in a referenced output producer", () => {
    configureHiddenRootBuild(
      outputBuildWorkflow([
        "set -e",
        'echo "target_context=." >> "$GITHUB_OUTPUT"',
        'echo "target_file=docker/Hidden.Dockerfile" >> "$GITHUB_OUTPUT"',
      ]),
    );

    expect(violations().join("\n")).toMatch(/set -e|errexit|unsupported|ambiguous/i);
  });

  it("excludes statically skipped and post-termination Docker commands", () => {
    configureSyntheticRepository({
      workflow: [
        "jobs:",
        "  build:",
        "    steps:",
        "      - run: |",
        "          true || docker build --file docker/or-skipped.Dockerfile .",
        "          false && docker build --file docker/and-skipped.Dockerfile .",
        "          ! true && docker build --file docker/negated-skipped.Dockerfile .",
        "          false && { docker build --file docker/group-skipped.Dockerfile .; }",
        "          exit 0",
        "          docker build --file docker/post-exit.Dockerfile .",
      ].join("\n"),
    });

    expect(rootContextDockerfiles(root)).toEqual(new Set());
    expect(violations()).toEqual([]);
  });

  it("discovers every statically reachable Docker command in AND/OR lists and groups", () => {
    const dockerfiles = [
      "docker/and.Dockerfile",
      "docker/or.Dockerfile",
      "docker/group.Dockerfile",
    ];
    configureSyntheticRepository({
      workflow: [
        "jobs:",
        "  build:",
        "    steps:",
        "      - run: |",
        "          true && docker build --file docker/and.Dockerfile .",
        "          false || docker build --file docker/or.Dockerfile .",
        "          { false || docker build --file docker/group.Dockerfile .; }",
      ].join("\n"),
    });
    for (const dockerfile of dockerfiles) write(dockerfile, "FROM scratch\nCOPY . .\n");

    expect(rootContextDockerfiles(root)).toEqual(new Set(dockerfiles));
  });

  it("conservatively discovers a Docker command gated by an unknown status", () => {
    configureHiddenRootBuild(
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - run: probe-service || docker build --file docker/Hidden.Dockerfile .",
      ].join("\n"),
    );

    expect(rootContextDockerfiles(root)).toEqual(new Set(["docker/Hidden.Dockerfile"]));
    expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
  });

  it.each([
    ["failed true redirect", "true > ."],
    ["failed colon redirect", ": > ."],
    ["failed echo redirect", "echo diagnostic > ."],
    ["failed printf redirect", "printf '%s\\n' diagnostic > ."],
    ["successful arbitrary-file redirect", "true > status.log"],
  ])("fails closed when redirect status can steer an output AND/OR list: %s", (_name, command) => {
    configureHiddenRootBuild(
      outputBuildWorkflow([
        'echo "target_context=." >> "$GITHUB_OUTPUT"',
        'echo "target_file=docker/Hidden.Dockerfile" >> "$GITHUB_OUTPUT"',
        `${command} && echo "target_context=services/docs" >> "$GITHUB_OUTPUT" || true`,
        `${command} && echo "target_file=docs/Dockerfile" >> "$GITHUB_OUTPUT" || true`,
      ]),
    );

    const result = violations().join("\n");
    expect(result).toMatch(/unsupported.*redirect|producer.*redirect/i);
  });

  it("does not discover Docker text from a direct static here-document body", () => {
    configureSyntheticRepository({
      workflow: [
        "jobs:",
        "  docs:",
        "    steps:",
        "      - run: |",
        "          cat <<'POLICY_EOF'",
        "          docker build --file docker/Fake.Dockerfile .",
        "          POLICY_EOF",
      ].join("\n"),
    });

    expect(rootContextDockerfiles(root)).toEqual(new Set());
    expect(violations()).toEqual([]);
  });

  it("discovers a Docker build expanded from an unquoted here-document body", () => {
    configureHiddenRootBuild(
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - run: |",
        "          cat <<POLICY_EOF",
        "          $(docker build --file docker/Hidden.Dockerfile .)",
        "          POLICY_EOF",
      ].join("\n"),
    );

    expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
    expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
  });

  it("does not treat quote characters in an unquoted here-document body as shell quoting", () => {
    configureHiddenRootBuild(
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - run: |",
        "          cat <<POLICY_EOF",
        "          '$(docker build --file docker/Hidden.Dockerfile .)'",
        "          POLICY_EOF",
      ].join("\n"),
    );

    expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
    expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
  });

  it("discovers a backtick build expanded from an unquoted here-document body", () => {
    configureHiddenRootBuild(
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - run: |",
        "          cat <<POLICY_EOF",
        "          `docker build --file docker/Hidden.Dockerfile .`",
        "          POLICY_EOF",
      ].join("\n"),
    );

    expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
    expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
  });

  it("associates an expanding here-document with its command before an AND terminator", () => {
    configureHiddenRootBuild(
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - run: |",
        "          cat <<POLICY_EOF && false && true",
        "          $(docker build --file docker/Hidden.Dockerfile .)",
        "          POLICY_EOF",
      ].join("\n"),
    );

    expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
    expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
  });

  it.each([
    ["input process substitution", "cat < <(docker build --file docker/Hidden.Dockerfile .)"],
    ["output process substitution", ": > >(docker build --file docker/Hidden.Dockerfile .)"],
    ["descriptor process substitution", "cat 3< <(docker build --file docker/Hidden.Dockerfile .)"],
    [
      "here-string command substitution",
      'cat <<< "$(docker build --file docker/Hidden.Dockerfile .)"',
    ],
  ])("discovers a Docker build executed through %s", (_name, command) => {
    configureHiddenRootBuild(
      ["jobs:", "  build:", "    steps:", `      - run: ${command}`].join("\n"),
    );

    expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
    expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
  });

  it.each([
    ["unquoted AND before", "echo $(docker build --file docker/Hidden.Dockerfile . && true)"],
    ["unquoted AND after", "echo $(true && docker build --file docker/Hidden.Dockerfile .)"],
    ["unquoted OR before", "echo $(docker build --file docker/Hidden.Dockerfile . || true)"],
    ["unquoted OR after", "echo $(false || docker build --file docker/Hidden.Dockerfile .)"],
    ["unquoted pipe before", "echo $(docker build --file docker/Hidden.Dockerfile . | cat)"],
    ["unquoted pipe after", "echo $(true | docker build --file docker/Hidden.Dockerfile .)"],
    ["unquoted sequence before", "echo $(docker build --file docker/Hidden.Dockerfile .; true)"],
    ["unquoted sequence after", "echo $(true; docker build --file docker/Hidden.Dockerfile .)"],
    ["unquoted background before", "echo $(docker build --file docker/Hidden.Dockerfile . & wait)"],
    ["unquoted background after", "echo $(true & docker build --file docker/Hidden.Dockerfile .)"],
    ["double-quoted AND", 'echo "$(docker build --file docker/Hidden.Dockerfile . && true)"'],
    ["backtick AND", "echo `docker build --file docker/Hidden.Dockerfile . && true`"],
    ["quoted backtick OR", 'echo "`docker build --file docker/Hidden.Dockerfile . || true`"'],
    [
      "input process substitution",
      "cat < <(docker build --file docker/Hidden.Dockerfile . && true)",
    ],
    [
      "output process substitution",
      ": > >(docker build --file docker/Hidden.Dockerfile . || true)",
    ],
    [
      "descriptor process substitution",
      "cat 3< <(docker build --file docker/Hidden.Dockerfile . | cat)",
    ],
    [
      "here-string substitution",
      "cat <<< $(docker build --file docker/Hidden.Dockerfile . && true)",
    ],
    [
      "nested substitution",
      'echo "$(echo "$(docker build --file docker/Hidden.Dockerfile . && true)")"',
    ],
    [
      "unknown OR branch",
      "echo $(probe-service || docker build --file docker/Hidden.Dockerfile .)",
    ],
    [
      "Docker option substitution",
      "docker build --label=revision=$(printf revision && true) --file docker/Hidden.Dockerfile .",
    ],
  ])("keeps executable substitution operators inside the owning node: %s", (_name, command) => {
    configureHiddenRootBuild(
      ["jobs:", "  build:", "    steps:", `      - run: ${command}`].join("\n"),
    );

    expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
    expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
  });

  it("keeps substitution words intact while locating a case header", () => {
    configureHiddenRootBuild(
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - run: |",
        "          case $(printf in && true) in",
        "            in) docker build --file docker/Hidden.Dockerfile . ;;",
        "          esac",
      ].join("\n"),
    );

    expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
    expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
  });

  it.each([
    [0, false],
    [1, true],
    [2, false],
    [3, false],
    [4, false],
    [5, true],
    [6, false],
    [7, false],
    [8, false],
    [9, false],
    [10, false],
    [13, false],
    [17, false],
    [21, false],
  ] as const)(
    "conservatively resolves legacy delimiter ownership for %i symmetric backslashes",
    (backslashes, expectedRootBuild) => {
      const command = legacyBacktickCommand(
        backslashes,
        "docker build --file docker/Hidden.Dockerfile .",
      );

      if (expectedRootBuild) {
        configureHiddenRootBuild(
          ["jobs:", "  build:", "    steps:", `      - run: ${command}`].join("\n"),
        );
        expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
        expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
      } else {
        configureSyntheticRepository({
          workflow: ["jobs:", "  docs:", "    steps:", `      - run: ${command}`].join("\n"),
        });
        expect(rootContextDockerfiles(root)).toEqual(new Set());
        expect(violations()).toEqual([]);
      }
    },
  );

  it.each([
    [1, 5, true],
    [5, 1, true],
    [5, 9, false],
    [9, 5, true],
  ] as const)(
    "conservatively resolves asymmetric legacy ownership for %i opening and %i closing backslashes",
    (opening, closing, expectedRootBuild) => {
      const command = legacyBacktickCommand(
        opening,
        "docker build --file docker/Hidden.Dockerfile .",
        closing,
      );

      if (expectedRootBuild) {
        configureHiddenRootBuild(
          ["jobs:", "  build:", "    steps:", `      - run: ${command}`].join("\n"),
        );
        expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
        expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
      } else {
        configureSyntheticRepository({
          workflow: ["jobs:", "  docs:", "    steps:", `      - run: ${command}`].join("\n"),
        });
        expect(rootContextDockerfiles(root)).toEqual(new Set());
        expect(violations()).toEqual([]);
      }
    },
  );

  it.each([
    [3, 5],
    [5, 3],
    [7, 9],
    [9, 7],
  ])(
    "fails closed when %i opening and %i closing legacy delimiters cannot pair",
    (opening, closing) => {
      const command = legacyBacktickCommand(
        opening,
        "docker build --file docker/Fake.Dockerfile .",
        closing,
      );
      const native = nativeLegacyResult(command);

      expect(native).toMatchObject({ dockerArgs: undefined, exitCode: 0 });
      expect(native.stderr).toMatch(/backtick|matching|unexpected|syntax/i);
      configureSyntheticRepository({
        workflow: ["jobs:", "  docs:", "    steps:", `      - run: ${command}`].join("\n"),
      });
      expect(violations().join("\n")).toMatch(/backtick|unbalanced|unterminated|ambiguous/i);
    },
  );

  it.each([
    ["late sequence", "true; docker build --file docker/Hidden.Dockerfile .", true],
    ["reachable OR", "false || docker build --file docker/Hidden.Dockerfile .", true],
    ["reachable pipeline", "docker build --file docker/Hidden.Dockerfile . | cat", true],
    ["reachable background", "docker build --file docker/Hidden.Dockerfile . & wait", true],
    ["successful exit", "exit 0; docker build --file docker/Hidden.Dockerfile .", false],
    ["failed AND", "false && docker build --file docker/Hidden.Dockerfile .", false],
    ["successful OR", "true || docker build --file docker/Hidden.Dockerfile .", false],
  ] as const)(
    "conservatively preserves status and list reachability through five-backslash legacy delimiters: %s",
    (_name, innerCommand, expectedExecution) => {
      const command = legacyBacktickCommand(5, innerCommand);
      if (expectedExecution) {
        configureHiddenRootBuild(
          ["jobs:", "  build:", "    steps:", `      - run: ${command}`].join("\n"),
        );
        expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
        expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
      } else {
        configureSyntheticRepository({
          workflow: ["jobs:", "  docs:", "    steps:", `      - run: ${command}`].join("\n"),
        });
        expect(rootContextDockerfiles(root)).toEqual(new Set());
        expect(violations()).toEqual([]);
      }
    },
  );

  it("executes five-backslash legacy delimiters inside double quotes", () => {
    const substitution = legacyBacktickCommand(
      5,
      "docker build --file docker/Hidden.Dockerfile .",
    ).slice("echo ".length);
    const command = `echo "${substitution}"`;

    configureHiddenRootBuild(
      ["jobs:", "  build:", "    steps:", `      - run: ${command}`].join("\n"),
    );
    expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
    expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
  });

  it("keeps five-backslash legacy-looking text inert inside single quotes", () => {
    const substitution = legacyBacktickCommand(
      5,
      "docker build --file docker/Fake.Dockerfile .",
    ).slice("echo ".length);
    const command = `echo '${substitution}'`;

    expect(nativeLegacyResult(command)).toMatchObject({
      dockerArgs: undefined,
      exitCode: 0,
      stderr: "",
    });
    configureSyntheticRepository({
      workflow: ["jobs:", "  docs:", "    steps:", `      - run: ${command}`].join("\n"),
    });
    expect(rootContextDockerfiles(root)).toEqual(new Set());
    expect(violations()).toEqual([]);
  });

  it.each([
    ["unquoted", "POLICY_EOF", true],
    ["single-quoted", "'POLICY_EOF'", false],
  ] as const)(
    "conservatively handles %s heredoc legacy expansion",
    (_name, delimiter, expectedExecution) => {
      const substitution = legacyBacktickCommand(
        5,
        "docker build --file docker/Hidden.Dockerfile .",
      ).slice("echo ".length);
      const command = [`cat <<${delimiter}`, substitution, "POLICY_EOF"].join("\n");

      if (expectedExecution) {
        configureHiddenRootBuild(
          [
            "jobs:",
            "  build:",
            "    steps:",
            "      - run: |",
            ...command.split("\n").map((line) => `          ${line}`),
          ].join("\n"),
        );
        expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
        expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
      } else {
        configureSyntheticRepository({
          workflow: [
            "jobs:",
            "  docs:",
            "    steps:",
            "      - run: |",
            ...command.split("\n").map((line) => `          ${line}`),
          ].join("\n"),
        });
        expect(rootContextDockerfiles(root)).toEqual(new Set());
        expect(violations()).toEqual([]);
      }
    },
  );

  it("discovers multiple legacy nesting levels with five- then three-backslash ownership", () => {
    const deeper = `echo ${"\\".repeat(3)}\`docker build --file docker/Hidden.Dockerfile .${"\\".repeat(3)}\``;
    const command = legacyBacktickCommand(5, deeper);

    expect(nativeLegacyResult(command).dockerArgs).toEqual([
      "build",
      "--file",
      "docker/Hidden.Dockerfile",
      ".",
    ]);
    configureHiddenRootBuild(
      ["jobs:", "  build:", "    steps:", `      - run: ${command}`].join("\n"),
    );
    expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
    expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
  });

  it("preserves legacy delimiter ownership through an intervening modern substitution", () => {
    const tick = "`";
    const slashes = "\\".repeat(5);
    const command = `echo ${tick}echo $(echo ${slashes}${tick}docker build --file docker/Hidden.Dockerfile .${slashes}${tick})${tick}`;

    configureHiddenRootBuild(
      ["jobs:", "  build:", "    steps:", `      - run: ${command}`].join("\n"),
    );
    expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
    expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
  });

  it("fails closed for an over-depth expansion owned by five-backslash delimiters", () => {
    const nested = `${"echo $(".repeat(18)}true${")".repeat(18)}`;
    const command = legacyBacktickCommand(5, nested);
    configureSyntheticRepository({
      workflow: ["jobs:", "  docs:", "    steps:", `      - run: ${command}`].join("\n"),
    });

    expect(violations().join("\n")).toMatch(/expansion.*depth|nesting.*limit/i);
  });

  it("fails closed for an over-node expansion owned by five-backslash delimiters", () => {
    const command = legacyBacktickCommand(5, Array.from({ length: 300 }, () => "true").join("; "));
    configureSyntheticRepository({
      workflow: ["jobs:", "  docs:", "    steps:", `      - run: ${command}`].join("\n"),
    });

    expect(violations().join("\n")).toMatch(/expansion.*node|too many.*nodes|node.*limit/i);
  });

  it.each([
    [0, true],
    [1, true],
    [2, false],
    [3, false],
    [4, true],
    [5, true],
    [6, false],
    [7, false],
    [8, true],
    [9, true],
    [10, false],
    [13, true],
    [17, true],
    [21, true],
  ] as const)(
    "matches native modern-substitution ownership after one legacy layer for %i backslashes",
    (backslashes, executes) => {
      const command = legacyModernSubstitutionCommand(
        backslashes,
        "docker build --file docker/Hidden.Dockerfile .",
      );
      const native = nativeLegacyResult(command);

      expect(native.exitCode).toBe(0);
      expect(native.dockerArgs).toEqual(
        executes ? ["build", "--file", "docker/Hidden.Dockerfile", "."] : undefined,
      );
      if (executes) {
        expect(native.stderr).toBe("");
        configureHiddenRootBuild(
          ["jobs:", "  build:", "    steps:", `      - run: ${command}`].join("\n"),
        );
        expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
        expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
      } else {
        expect(native.stderr).toMatch(/syntax|unexpected/i);
        configureSyntheticRepository({
          workflow: ["jobs:", "  docs:", "    steps:", `      - run: ${command}`].join("\n"),
        });
        expect(violations()).not.toEqual([]);
      }
    },
  );

  it.each([
    [0, true],
    [1, true],
    [2, true],
    [3, true],
    [4, false],
    [5, false],
    [6, false],
    [7, false],
    [8, true],
    [9, true],
    [10, true],
    [13, false],
    [17, true],
    [21, false],
  ] as const)(
    "matches native modern-substitution ownership after two legacy layers for %i backslashes",
    (backslashes, executes) => {
      const command = doubleLegacyModernSubstitutionCommand(
        backslashes,
        "docker build --file docker/Hidden.Dockerfile .",
      );
      const native = nativeLegacyResult(command);

      expect(native.exitCode).toBe(0);
      expect(native.dockerArgs).toEqual(
        executes ? ["build", "--file", "docker/Hidden.Dockerfile", "."] : undefined,
      );
      if (executes) {
        expect(native.stderr).toBe("");
        configureHiddenRootBuild(
          ["jobs:", "  build:", "    steps:", `      - run: ${command}`].join("\n"),
        );
        expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
        expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
      } else {
        expect(native.stderr).toMatch(/syntax|unexpected/i);
        configureSyntheticRepository({
          workflow: ["jobs:", "  docs:", "    steps:", `      - run: ${command}`].join("\n"),
        });
        expect(violations()).not.toEqual([]);
      }
    },
  );

  it.each([
    [1, 5],
    [5, 1],
    [5, 9],
    [9, 5],
  ])(
    "discovers escaped modern substitution through %i/%i pairable legacy delimiters",
    (opening, closing) => {
      const command = legacyBacktickCommand(
        opening,
        "echo \\$(docker build --file docker/Hidden.Dockerfile .)",
        closing,
      );

      expect(nativeLegacyResult(command)).toMatchObject({
        dockerArgs: ["build", "--file", "docker/Hidden.Dockerfile", "."],
        exitCode: 0,
        stderr: "",
      });
      configureHiddenRootBuild(
        ["jobs:", "  build:", "    steps:", `      - run: ${command}`].join("\n"),
      );
      expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
      expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
    },
  );

  it.each([
    [3, 5],
    [5, 3],
    [7, 9],
    [9, 7],
  ])(
    "fails closed for escaped modern substitution through %i/%i mixed legacy delimiters",
    (opening, closing) => {
      const command = legacyBacktickCommand(
        opening,
        "echo \\$(docker build --file docker/Fake.Dockerfile .)",
        closing,
      );
      const native = nativeLegacyResult(command);

      expect(native.dockerArgs).toBeUndefined();
      expect(native.stderr).toMatch(/backtick|matching|unexpected|syntax/i);
      configureSyntheticRepository({
        workflow: ["jobs:", "  docs:", "    steps:", `      - run: ${command}`].join("\n"),
      });
      expect(violations().join("\n")).toMatch(/backtick|unbalanced|unterminated|ambiguous/i);
    },
  );

  it.each([
    ["reachable OR", "false || docker build --file docker/Hidden.Dockerfile .", true],
    ["pipeline", "docker build --file docker/Hidden.Dockerfile . | cat", true],
    ["background", "docker build --file docker/Hidden.Dockerfile . & wait", true],
    ["successful exit", "exit 0; docker build --file docker/Hidden.Dockerfile .", false],
    ["failed AND", "false && docker build --file docker/Hidden.Dockerfile .", false],
    ["successful OR", "true || docker build --file docker/Hidden.Dockerfile .", false],
  ] as const)(
    "preserves status through an escaped modern substitution in a legacy body: %s",
    (_name, innerCommand, executes) => {
      const command = legacyModernSubstitutionCommand(1, innerCommand);
      const native = nativeLegacyResult(command);

      expect(native.dockerArgs).toEqual(
        executes ? ["build", "--file", "docker/Hidden.Dockerfile", "."] : undefined,
      );
      expect(native.stderr).toBe("");
      if (executes) {
        configureHiddenRootBuild(
          ["jobs:", "  build:", "    steps:", `      - run: ${command}`].join("\n"),
        );
        expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
        expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
      } else {
        configureSyntheticRepository({
          workflow: ["jobs:", "  docs:", "    steps:", `      - run: ${command}`].join("\n"),
        });
        expect(rootContextDockerfiles(root)).toEqual(new Set());
        expect(violations()).toEqual([]);
      }
    },
  );

  it("discovers escaped modern substitution inside a double-quoted legacy substitution", () => {
    const substitution = legacyModernSubstitutionCommand(
      1,
      "docker build --file docker/Hidden.Dockerfile .",
    ).slice("echo ".length);
    const command = `echo "${substitution}"`;

    expect(nativeLegacyResult(command)).toMatchObject({
      dockerArgs: ["build", "--file", "docker/Hidden.Dockerfile", "."],
      exitCode: 0,
      stderr: "",
    });
    configureHiddenRootBuild(
      ["jobs:", "  build:", "    steps:", `      - run: ${command}`].join("\n"),
    );
    expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
    expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
  });

  it.each([
    ["unquoted", "POLICY_EOF", true],
    ["single-quoted", "'POLICY_EOF'", false],
  ] as const)(
    "matches native %s heredoc ownership for escaped modern substitution",
    (_name, delimiter, executes) => {
      const substitution = legacyModernSubstitutionCommand(
        1,
        "docker build --file docker/Hidden.Dockerfile .",
      ).slice("echo ".length);
      const command = [`cat <<${delimiter}`, substitution, "POLICY_EOF"].join("\n");

      expect(nativeLegacyResult(command).dockerArgs).toEqual(
        executes ? ["build", "--file", "docker/Hidden.Dockerfile", "."] : undefined,
      );
      if (executes) {
        configureHiddenRootBuild(
          [
            "jobs:",
            "  build:",
            "    steps:",
            "      - run: |",
            ...command.split("\n").map((line) => `          ${line}`),
          ].join("\n"),
        );
        expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
        expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
      } else {
        configureSyntheticRepository({
          workflow: [
            "jobs:",
            "  docs:",
            "    steps:",
            "      - run: |",
            ...command.split("\n").map((line) => `          ${line}`),
          ].join("\n"),
        });
        expect(rootContextDockerfiles(root)).toEqual(new Set());
        expect(violations()).toEqual([]);
      }
    },
  );

  it("discovers modern inside legacy inside modern substitutions", () => {
    const legacy = legacyModernSubstitutionCommand(
      1,
      "docker build --file docker/Hidden.Dockerfile .",
    ).slice("echo ".length);
    const command = `echo $(echo ${legacy})`;

    expect(nativeLegacyResult(command)).toMatchObject({
      dockerArgs: ["build", "--file", "docker/Hidden.Dockerfile", "."],
      exitCode: 0,
      stderr: "",
    });
    configureHiddenRootBuild(
      ["jobs:", "  build:", "    steps:", `      - run: ${command}`].join("\n"),
    );
    expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
    expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
  });

  it("does not reparse a parameter value exposed by a legacy dollar escape as a command", () => {
    const dollar = "$";
    const command = `TRACK11='docker build --file docker/Fake.Dockerfile .'; echo \`echo \\${dollar}{TRACK11}\``;
    const native = nativeLegacyResult(command);

    expect(native).toMatchObject({ dockerArgs: undefined, exitCode: 0, stderr: "" });
    expect(native.stdout).toBe("docker build --file docker/Fake.Dockerfile .");
    configureSyntheticRepository({
      workflow: ["jobs:", "  docs:", "    steps:", `      - run: ${command}`].join("\n"),
    });
    expect(rootContextDockerfiles(root)).toEqual(new Set());
    expect(violations()).toEqual([]);
  });

  it("keeps an even legacy escape pair before a parameter expansion literal", () => {
    const dollar = "$";
    const command = `TRACK11=value; echo \`echo \\\\${dollar}{TRACK11}\``;
    const native = nativeLegacyResult(command);

    expect(native).toMatchObject({ dockerArgs: undefined, exitCode: 0, stderr: "" });
    expect(native.stdout).toBe(["$", "{TRACK11}"].join(""));
    configureSyntheticRepository({
      workflow: ["jobs:", "  docs:", "    steps:", `      - run: ${command}`].join("\n"),
    });
    expect(rootContextDockerfiles(root)).toEqual(new Set());
    expect(violations()).toEqual([]);
  });

  it("fails closed when legacy ownership exposes arithmetic expansion", () => {
    const dollar = "$";
    const command = `echo \`echo \\${dollar}((1 + 1))\``;

    expect(nativeLegacyResult(command)).toMatchObject({
      dockerArgs: undefined,
      exitCode: 0,
      stderr: "",
      stdout: "2",
    });
    configureSyntheticRepository({
      workflow: ["jobs:", "  docs:", "    steps:", `      - run: ${command}`].join("\n"),
    });
    expect(violations().join("\n")).toMatch(/arithmetic|unsupported|ambiguous/i);
  });

  it.each([
    [1, "<x>"],
    [2, "<x>"],
    [3, "<\\x>"],
  ])("matches native legacy backslash-pair consumption for count %i", (backslashes, stdout) => {
    const command = `echo \`printf "<%s>" ${"\\".repeat(backslashes)}x\``;

    expect(nativeLegacyResult(command)).toMatchObject({
      dockerArgs: undefined,
      exitCode: 0,
      stderr: "",
      stdout,
    });
    configureSyntheticRepository({
      workflow: ["jobs:", "  docs:", "    steps:", `      - run: ${command}`].join("\n"),
    });
    expect(violations()).toEqual([]);
  });

  it.each([
    [1, true],
    [2, true],
    [3, false],
    [4, true],
  ] as const)(
    "matches native legacy backslash-newline ownership for count %i",
    (backslashes, executes) => {
      const command = `echo \`echo $${"\\".repeat(backslashes)}\n(docker build --file docker/Hidden.Dockerfile .)\``;
      const native = nativeLegacyResult(command);

      expect(native.dockerArgs).toEqual(
        executes ? ["build", "--file", "docker/Hidden.Dockerfile", "."] : undefined,
      );
      if (executes) {
        configureHiddenRootBuild(
          [
            "jobs:",
            "  build:",
            "    steps:",
            "      - run: |",
            ...command.split("\n").map((line) => `          ${line}`),
          ].join("\n"),
        );
        expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
        expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
      } else {
        expect(native.stderr).toMatch(/syntax|unexpected/i);
        configureSyntheticRepository({
          workflow: [
            "jobs:",
            "  docs:",
            "    steps:",
            "      - run: |",
            ...command.split("\n").map((line) => `          ${line}`),
          ].join("\n"),
        });
        expect(violations()).not.toEqual([]);
      }
    },
  );

  it("fails closed for an unbalanced modern substitution exposed by legacy ownership", () => {
    const dollar = "$";
    const command = `echo \`echo \\${dollar}(docker build --file docker/Fake.Dockerfile .\``;
    const native = nativeLegacyResult(command);

    expect(native.dockerArgs).toBeUndefined();
    expect(native.stderr).toMatch(/matching|unexpected|syntax|substitution/i);
    configureSyntheticRepository({
      workflow: ["jobs:", "  docs:", "    steps:", `      - run: ${command}`].join("\n"),
    });
    expect(violations()).not.toEqual([]);
  });

  it("fails closed for over-depth modern substitution exposed by legacy ownership", () => {
    const nested = `${"echo $(".repeat(18)}true${")".repeat(18)}`;
    const command = legacyModernSubstitutionCommand(1, nested);
    configureSyntheticRepository({
      workflow: ["jobs:", "  docs:", "    steps:", `      - run: ${command}`].join("\n"),
    });

    expect(violations().join("\n")).toMatch(/expansion.*depth|nesting.*limit/i);
  });

  it("fails closed for over-node modern substitution exposed by legacy ownership", () => {
    const command = legacyModernSubstitutionCommand(
      1,
      Array.from({ length: 300 }, () => "true").join("; "),
    );
    configureSyntheticRepository({
      workflow: ["jobs:", "  docs:", "    steps:", `      - run: ${command}`].join("\n"),
    });

    expect(violations().join("\n")).toMatch(/expansion.*node|too many.*nodes|node.*limit/i);
  });

  it.each([
    [
      "nested legacy substitution",
      "echo `echo \\`docker build --file docker/Hidden.Dockerfile .\\``",
    ],
    [
      "nested legacy sequence",
      "echo `echo \\`docker build --file docker/Hidden.Dockerfile .; true\\``",
    ],
    [
      "nested legacy OR branch",
      "echo `echo \\`false || docker build --file docker/Hidden.Dockerfile .\\``",
    ],
    [
      "double-quoted outer legacy substitution",
      'echo "`echo \\`docker build --file docker/Hidden.Dockerfile .\\``"',
    ],
    [
      "nested legacy substitution in process substitution",
      "cat < <(echo `echo \\`docker build --file docker/Hidden.Dockerfile .\\``)",
    ],
    [
      "two nested legacy levels",
      "echo `echo \\`echo \\\\\\`docker build --file docker/Hidden.Dockerfile .\\\\\\`\\``",
    ],
    [
      "even backslash parity outside legacy context",
      "echo \\\\`docker build --file docker/Hidden.Dockerfile .`",
    ],
  ])("discovers a build through executable legacy backtick context: %s", (_name, command) => {
    configureHiddenRootBuild(
      ["jobs:", "  build:", "    steps:", `      - run: ${command}`].join("\n"),
    );

    expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
    expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
  });

  it("discovers nested legacy backticks expanded from an unquoted here-document", () => {
    configureHiddenRootBuild(
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - run: |",
        "          cat <<POLICY_EOF",
        "          `echo \\`docker build --file docker/Hidden.Dockerfile .\\``",
        "          POLICY_EOF",
      ].join("\n"),
    );

    expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
    expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
  });

  it.each([
    [
      "inner exit sequence",
      "echo `echo \\`exit 0; docker build --file docker/Fake.Dockerfile .\\``",
    ],
    ["inner failed AND", "echo `echo \\`false && docker build --file docker/Fake.Dockerfile .\\``"],
    [
      "inner successful OR",
      "echo `echo \\`true || docker build --file docker/Fake.Dockerfile .\\``",
    ],
    [
      "odd escaped backticks outside legacy context",
      "echo \\`docker build --file docker/Fake.Dockerfile .\\`",
    ],
  ])("keeps unreachable or literal legacy backticks inert: %s", (_name, command) => {
    configureSyntheticRepository({
      workflow: ["jobs:", "  docs:", "    steps:", `      - run: ${command}`].join("\n"),
    });

    expect(rootContextDockerfiles(root)).toEqual(new Set());
    expect(violations()).toEqual([]);
  });

  it("fails closed for unbalanced escaped legacy backtick nesting", () => {
    configureSyntheticRepository({
      workflow: [
        "jobs:",
        "  docs:",
        "    steps:",
        "      - run: echo `echo \\`printf ambiguous`",
      ].join("\n"),
    });

    expect(violations().join("\n")).toMatch(/backtick|unbalanced|unterminated|ambiguous/i);
  });

  it.each([
    ["double-quoted input form", 'echo "<(docker build --file docker/Fake.Dockerfile .)"'],
    ["double-quoted output form", 'echo ">(docker build --file docker/Fake.Dockerfile .)"'],
    ["single-quoted input form", "echo '<(docker build --file docker/Fake.Dockerfile .)'"],
    ["escaped input form", "echo \\<\\(docker build --file docker/Fake.Dockerfile .\\)"],
    ["double-quoted here-string form", 'cat <<< "<(docker build --file docker/Fake.Dockerfile .)"'],
    ["nested double-quoted form", 'echo $(echo "<(docker build --file docker/Fake.Dockerfile .)")'],
  ])("keeps process-substitution-looking text inert: %s", (_name, command) => {
    configureSyntheticRepository({
      workflow: ["jobs:", "  docs:", "    steps:", `      - run: ${command}`].join("\n"),
    });

    expect(rootContextDockerfiles(root)).toEqual(new Set());
    expect(violations()).toEqual([]);
  });

  it("keeps process-substitution-looking text inert in an expanding here-document", () => {
    configureSyntheticRepository({
      workflow: [
        "jobs:",
        "  docs:",
        "    steps:",
        "      - run: |",
        "          cat <<POLICY_EOF",
        "          <(docker build --file docker/Fake.Dockerfile .)",
        "          >(docker build --file docker/Fake.Dockerfile .)",
        "          POLICY_EOF",
      ].join("\n"),
    });

    expect(rootContextDockerfiles(root)).toEqual(new Set());
    expect(violations()).toEqual([]);
  });

  it.each([
    ["exit sequence", "echo $(exit 0; docker build --file docker/Fake.Dockerfile .)"],
    ["failed AND", "echo $(false && docker build --file docker/Fake.Dockerfile .)"],
    ["successful OR", "echo $(true || docker build --file docker/Fake.Dockerfile .)"],
    ["quoted exit sequence", 'echo "$(exit 0; docker build --file docker/Fake.Dockerfile .)"'],
    ["process substitution exit", "cat < <(exit 0; docker build --file docker/Fake.Dockerfile .)"],
    ["here-string failed AND", "cat <<< $(false && docker build --file docker/Fake.Dockerfile .)"],
    [
      "nested failed AND",
      'echo "$(echo "$(false && docker build --file docker/Fake.Dockerfile .)")"',
    ],
    ["single-quoted literal", "echo '$(docker build --file docker/Fake.Dockerfile . && true)'"],
    ["escaped literal", 'echo "\\$(docker build --file docker/Fake.Dockerfile . && true)"'],
  ])("does not execute an unreachable or literal nested substitution: %s", (_name, command) => {
    configureSyntheticRepository({
      workflow: ["jobs:", "  docs:", "    steps:", `      - run: ${command}`].join("\n"),
    });

    expect(rootContextDockerfiles(root)).toEqual(new Set());
    expect(violations()).toEqual([]);
  });

  it("fails closed when executable substitution nesting exceeds the supported depth", () => {
    const nested = `${"echo $(".repeat(18)}true${")".repeat(18)}`;
    configureSyntheticRepository({
      workflow: ["jobs:", "  docs:", "    steps:", `      - run: ${nested}`].join("\n"),
    });

    expect(violations().join("\n")).toMatch(/expansion.*depth|nesting.*limit/i);
  });

  it("fails closed when an executable substitution exceeds the supported node limit", () => {
    const commands = Array.from({ length: 300 }, () => "true").join("; ");
    configureSyntheticRepository({
      workflow: ["jobs:", "  docs:", "    steps:", `      - run: echo $(${commands})`].join("\n"),
    });

    expect(violations().join("\n")).toMatch(/expansion.*node|too many.*nodes|node.*limit/i);
  });

  it("discovers command substitution after an apostrophe inside double quotes", () => {
    configureHiddenRootBuild(
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - run: |",
        '          echo "it\'s $(docker build --file docker/Hidden.Dockerfile .)"',
      ].join("\n"),
    );

    expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
    expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
  });

  it("keeps command-substitution text in a shell comment inert", () => {
    configureSyntheticRepository({
      workflow: [
        "jobs:",
        "  docs:",
        "    steps:",
        "      - run: |",
        "          # $(docker build --file docker/Fake.Dockerfile .)",
        "          echo safe",
      ].join("\n"),
    });

    expect(rootContextDockerfiles(root)).toEqual(new Set());
    expect(violations()).toEqual([]);
  });

  it("does not discover a command substitution after successful shell termination", () => {
    configureSyntheticRepository({
      workflow: [
        "jobs:",
        "  docs:",
        "    steps:",
        "      - run: |",
        "          exit 0",
        '          echo "$(docker build --file docker/Fake.Dockerfile .)"',
      ].join("\n"),
    });

    expect(rootContextDockerfiles(root)).toEqual(new Set());
    expect(violations()).toEqual([]);
  });

  it("fails closed for an ambiguous command substitution in an expanding here-document", () => {
    configureHiddenRootBuild(
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - run: |",
        "          cat <<POLICY_EOF",
        '          $("$BUILD_COMMAND" build --file docker/Hidden.Dockerfile .)',
        "          POLICY_EOF",
      ].join("\n"),
    );

    expect(violations().join("\n")).toMatch(/ambiguous|dynamic|unsupported/i);
  });

  it.each([
    ["unbalanced process substitution", "cat < <(docker build --file docker/Hidden.Dockerfile ."],
    [
      "multiple here-documents",
      ["cat <<FIRST_EOF <<'SECOND_EOF'", "FIRST_EOF", "SECOND_EOF"].join("\n          "),
    ],
  ])("fails closed for unsupported expansion structure: %s", (_name, command) => {
    configureHiddenRootBuild(
      ["jobs:", "  build:", "    steps:", "      - run: |", `          ${command}`].join("\n"),
    );

    expect(violations().join("\n")).toMatch(/unterminated|multiple|unsupported/i);
  });

  it.each([
    ["input redirect", "true < /dev/null"],
    ["stdout close", "true >&-"],
    ["stderr file", "true 2>/dev/null"],
    ["fd duplication", "true 2>&1"],
    ["fd input duplication", "true 3<&0"],
    ["combined stdout and stderr", "true &>/dev/null"],
    ["here string", "true <<< input"],
  ])("rejects an unvalidated producer fd/redirection form: %s", (_name, command) => {
    configureHiddenRootBuild(
      outputBuildWorkflow([
        'echo "target_context=." >> "$GITHUB_OUTPUT"',
        'echo "target_file=docker/Hidden.Dockerfile" >> "$GITHUB_OUTPUT"',
        `${command} && echo "target_context=services/docs" >> "$GITHUB_OUTPUT"`,
      ]),
    );

    expect(violations().join("\n")).toMatch(/unsupported.*redirect|producer.*redirect/i);
  });

  it("rejects a referenced producer here-document instead of parsing its body as commands", () => {
    configureHiddenRootBuild(
      outputBuildWorkflow([
        "true <<'POLICY_EOF' && true",
        "docker build --file docker/Fake.Dockerfile .",
        "POLICY_EOF",
        'echo "target_context=." >> "$GITHUB_OUTPUT"',
        'echo "target_file=docker/Hidden.Dockerfile" >> "$GITHUB_OUTPUT"',
      ]),
    );

    const result = violations().join("\n");
    expect(result).toMatch(/unsupported.*redirect|producer.*redirect/i);
    expect(result).not.toContain("docker/Fake.Dockerfile");
  });

  it("fails closed when a compound-group redirect can change an output list status", () => {
    configureHiddenRootBuild(
      outputBuildWorkflow([
        'echo "target_context=." >> "$GITHUB_OUTPUT"',
        'echo "target_file=docker/Hidden.Dockerfile" >> "$GITHUB_OUTPUT"',
        '{ true; } > . && echo "target_context=services/docs" >> "$GITHUB_OUTPUT" || true',
        '{ true; } > . && echo "target_file=docs/Dockerfile" >> "$GITHUB_OUTPUT" || true',
      ]),
    );

    expect(violations().join("\n")).toMatch(/unsupported.*redirect|producer.*redirect/i);
  });

  it("keeps a Docker OR branch feasible when a redirected terminating group can fail", () => {
    configureHiddenRootBuild(
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - run: '{ exit 0; } > . || docker build --file docker/Hidden.Dockerfile .'",
      ].join("\n"),
    );

    expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
    expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
  });

  it.each([
    ["echo", "echo diagnostic >&2"],
    ["printf", "printf '%s\\n' diagnostic >&2"],
  ])("accepts an exact stderr-only diagnostic before exact outputs: %s", (_name, diagnostic) => {
    expectHiddenRootPolicyViolation([
      diagnostic,
      'echo "target_context=." >> "$GITHUB_OUTPUT"',
      'echo "target_file=docker/Hidden.Dockerfile" >> "$GITHUB_OUTPUT"',
    ]);
  });

  it.each([
    ["plain", "exec true"],
    ["absolute", "exec /usr/bin/true"],
    ["env target", "exec env true"],
    ["command wrapper", "command exec true"],
    ["builtin wrapper", "builtin exec true"],
    ["nested command/builtin wrapper", "command builtin exec true"],
    ["command as exec target", "exec command true"],
  ])(
    "preserves root outputs and skips writes after successful static exec: %s",
    (_name, command) => {
      expectHiddenRootPolicyViolation([
        'echo "target_context=." >> "$GITHUB_OUTPUT"',
        'echo "target_file=docker/Hidden.Dockerfile" >> "$GITHUB_OUTPUT"',
        command,
        'echo "target_context=services/docs" >> "$GITHUB_OUTPUT"',
        'echo "target_file=docs/Dockerfile" >> "$GITHUB_OUTPUT"',
      ]);
    },
  );

  it.each(["exec false", "exec /usr/bin/false", "command exec false"])(
    "does not run the consuming action or post-exec writes after failed static exec: %s",
    (command) => {
      configureHiddenRootBuild(
        outputBuildWorkflow([
          'echo "target_context=services/docs" >> "$GITHUB_OUTPUT"',
          'echo "target_file=docs/Dockerfile" >> "$GITHUB_OUTPUT"',
          command,
          'echo "target_context=." >> "$GITHUB_OUTPUT"',
          'echo "target_file=docker/Hidden.Dockerfile" >> "$GITHUB_OUTPUT"',
        ]),
      );

      expect(rootContextDockerfiles(root)).toEqual(new Set());
      expect(violations()).toEqual([]);
    },
  );

  it("does not execute an OR-list RHS after exec successfully replaces the shell", () => {
    configureSyntheticRepository({
      workflow: [
        "jobs:",
        "  build:",
        "    steps:",
        "      - run: exec false || docker build --file docker/unreachable.Dockerfile .",
      ].join("\n"),
    });

    expect(rootContextDockerfiles(root)).toEqual(new Set());
    expect(violations()).toEqual([]);
  });

  it("discovers a Docker build executed through exec and excludes later commands", () => {
    configureHiddenRootBuild(
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - run: |",
        "          exec docker build --file docker/Hidden.Dockerfile .",
        "          docker build --file docker/post-exec.Dockerfile .",
      ].join("\n"),
    );

    expect(rootContextDockerfiles(root)).toEqual(new Set(["docker/Hidden.Dockerfile"]));
    expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
  });

  it.each(['exec "$COMMAND"', "exec eval 'true'", "exec env -S 'true'"])(
    "fails closed for a dynamic or unsupported exec target: %s",
    (command) => {
      configureHiddenRootBuild(
        outputBuildWorkflow([
          'echo "target_context=." >> "$GITHUB_OUTPUT"',
          'echo "target_file=docker/Hidden.Dockerfile" >> "$GITHUB_OUTPUT"',
          command,
        ]),
      );

      expect(violations().join("\n")).toMatch(/exec|dynamic|unsupported|ambiguous/i);
    },
  );

  it.each([
    ["env", "env exec true || docker build --file docker/Hidden.Dockerfile ."],
    ["absolute env", "/usr/bin/env exec false || docker build --file docker/Hidden.Dockerfile ."],
    ["command plus env", "command env exec true || docker build --file docker/Hidden.Dockerfile ."],
    [
      "env plus command",
      "env command exec false || docker build --file docker/Hidden.Dockerfile .",
    ],
  ])(
    "does not treat an external wrapper's exec argument as shell replacement: %s",
    (_name, command) => {
      configureHiddenRootBuild(
        ["jobs:", "  build:", "    steps:", `      - run: ${command}`].join("\n"),
      );

      expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
      expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
    },
  );

  it.each([
    ["exit on the left", "exit 0 | docker build --file docker/Hidden.Dockerfile ."],
    ["return on the left", "return 1 | docker build --file docker/Hidden.Dockerfile ."],
    ["exit in the middle", "true | exit 0 | docker build --file docker/Hidden.Dockerfile ."],
    ["exit on the right", "docker build --file docker/Hidden.Dockerfile . | exit 0"],
  ])("discovers every feasible Docker pipeline component: %s", (_name, command) => {
    configureHiddenRootBuild(
      ["jobs:", "  build:", "    steps:", `      - run: ${command}`].join("\n"),
    );

    expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
    expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
  });

  it.each([
    ["exit", "exit 0 & docker build --file docker/Hidden.Dockerfile ."],
    ["return", "return 1 & docker build --file docker/Hidden.Dockerfile ."],
    [
      "wait",
      "docker build --file docker/Hidden.Dockerfile . & wait && docker build --file docker/after-wait.Dockerfile .",
    ],
  ])("keeps parent discovery live across a background command: %s", (_name, command) => {
    configureHiddenRootBuild(
      ["jobs:", "  build:", "    steps:", `      - run: ${command}`].join("\n"),
    );
    if (command.includes("after-wait")) write("docker/after-wait.Dockerfile", "FROM scratch\n");

    expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
    expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
  });

  it.each([
    ["exit before AND", "exit 0 && true & docker build --file docker/Hidden.Dockerfile ."],
    ["return before OR", "return 1 || true & docker build --file docker/Hidden.Dockerfile ."],
    ["exec before AND", "exec true && true & docker build --file docker/Hidden.Dockerfile ."],
    [
      "background build before exit",
      "docker build --file docker/Hidden.Dockerfile . && exit 0 & true",
    ],
    [
      "mixed AND/OR",
      "true && exit 0 || false && true & docker build --file docker/Hidden.Dockerfile .",
    ],
  ])("localizes the complete asynchronous AND/OR list: %s", (_name, command) => {
    configureHiddenRootBuild(
      ["jobs:", "  build:", "    steps:", `      - run: ${command}`].join("\n"),
    );

    expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
    expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
  });

  it.each([
    ["pipeline exit", "exit 0 | true"],
    ["pipeline return", "return 1 | true"],
    ["background exit", "exit 0 & true"],
    ["background return", "return 1 & wait"],
  ])(
    "rejects concurrent control in a referenced output producer before termination: %s",
    (_name, command) => {
      configureHiddenRootBuild(
        outputBuildWorkflow([
          'echo "target_context=." >> "$GITHUB_OUTPUT"',
          'echo "target_file=docker/Hidden.Dockerfile" >> "$GITHUB_OUTPUT"',
          command,
        ]),
      );

      expect(violations().join("\n")).toMatch(/pipeline|background|concurrent|unsupported/i);
    },
  );

  it.each(["set -o pipefail", "set +o pipefail"])(
    "conservatively includes a build after an unresolved pipeline status with %s",
    (pipefail) => {
      configureHiddenRootBuild(
        [
          "jobs:",
          "  build:",
          "    steps:",
          "      - run: |",
          `          ${pipefail}`,
          "          false | true && docker build --file docker/Hidden.Dockerfile .",
        ].join("\n"),
      );

      expect(rootContextDockerfiles(root)).toContain("docker/Hidden.Dockerfile");
      expect(violations().join("\n")).toContain("docker/Hidden.Dockerfile.dockerignore");
    },
  );

  it("fails closed instead of combining outputs from inactive alternative arms", () => {
    configureSyntheticRepository({
      workflow: [
        "jobs:",
        "  production:",
        "    steps:",
        "      - id: resolve",
        "        run: |",
        '          case "$SERVICE" in',
        '            context-only) echo "target_context=." >> "$GITHUB_OUTPUT" ;;',
        '            file-only) echo "target_file=docker/Hidden.Dockerfile" >> "$GITHUB_OUTPUT" ;;',
        "            *) exit 1 ;;",
        "          esac",
        "      - uses: docker/build-push-action@v6",
        "        with:",
        `          context: ${githubExpression("steps.resolve.outputs.target_context")}`,
        `          file: ${githubExpression("steps.resolve.outputs.target_file")}`,
      ].join("\n"),
    });

    expect(violations().join("\n")).toMatch(/incomplete|ambiguous|unresolved/i);
  });

  it("fails closed when a case output producer has no exhaustive or terminating fallback", () => {
    configureSyntheticRepository({
      workflow: [
        "jobs:",
        "  production:",
        "    steps:",
        "      - id: resolve",
        "        run: |",
        '          case "$SERVICE" in',
        '            docs) echo "target_context=services/docs" >> "$GITHUB_OUTPUT"; echo "target_file=docs/Dockerfile" >> "$GITHUB_OUTPUT" ;;',
        "          esac",
        "      - uses: docker/build-push-action@v6",
        "        with:",
        `          context: ${githubExpression("steps.resolve.outputs.target_context")}`,
        `          file: ${githubExpression("steps.resolve.outputs.target_file")}`,
      ].join("\n"),
    });

    expect(violations().join("\n")).toMatch(/ambiguous|incomplete|unresolved|exhaustive/i);
  });

  it("fails closed when a case construct is not structurally balanced", () => {
    configureSyntheticRepository({
      workflow: [
        "jobs:",
        "  build:",
        "    steps:",
        "      - run: |",
        '          case "$SERVICE" in',
        "            api) docker build --file docker/Hidden.Dockerfile . ;;",
      ].join("\n"),
    });

    expect(() => rootContextDockerfiles(root)).toThrow(/case|shell|structur/i);
  });

  it("binds matrix property references to the exact consuming job", () => {
    configureSyntheticRepository({
      workflow: [
        "jobs:",
        "  production:",
        "    strategy:",
        "      matrix:",
        "        include:",
        "          - target_context: .",
        "            target_file: docker/real.Dockerfile",
        "    steps:",
        "      - uses: docker/build-push-action@v6",
        "        with:",
        `          context: ${githubExpression("matrix.target_context")}`,
        `          file: ${githubExpression("matrix.target_file")}`,
        "  unrelated:",
        "    strategy:",
        "      matrix:",
        "        include:",
        "          - context: services/docs",
        "            dockerfile: docs/Dockerfile",
      ].join("\n"),
    });
    write("docker/real.Dockerfile", "FROM scratch\nCOPY . /app\n");
    write("docker/real.Dockerfile.dockerignore", "node_modules/\n");

    expect(rootContextDockerfiles(root)).toEqual(new Set(["docker/real.Dockerfile"]));
    expect(violations().join("\n")).toContain("docker/real.Dockerfile.dockerignore");
  });

  it("keeps valid matrix mappings isolated across multiple jobs", () => {
    configureSyntheticRepository({
      workflow: [
        "jobs:",
        "  production:",
        "    strategy:",
        "      matrix:",
        "        include:",
        "          - context: .",
        "            dockerfile: docker/real.Dockerfile",
        "    steps:",
        "      - uses: docker/build-push-action@v6",
        "        with:",
        `          context: ${githubExpression("matrix.context")}`,
        `          file: ${githubExpression("matrix.dockerfile")}`,
        "  unrelated:",
        "    strategy:",
        "      matrix:",
        "        include:",
        "          - context: services/docs",
        "            dockerfile: docs/Dockerfile",
        "    steps:",
        "      - uses: docker/build-push-action@v6",
        "        with:",
        `          context: ${githubExpression("matrix.context")}`,
        `          file: ${githubExpression("matrix.dockerfile")}`,
      ].join("\n"),
    });

    expect(rootContextDockerfiles(root)).toEqual(new Set(["docker/real.Dockerfile"]));
  });

  it("binds output references to the exact step ID and output keys in the consuming job", () => {
    configureSyntheticRepository({
      workflow: [
        "jobs:",
        "  production:",
        "    steps:",
        "      - id: resolve",
        "        run: |",
        '          echo "target_context=." >> "$GITHUB_OUTPUT"',
        '          echo "target_file=docker/real.Dockerfile" >> "$GITHUB_OUTPUT"',
        "      - uses: docker/build-push-action@v6",
        "        with:",
        `          context: ${githubExpression("steps.resolve.outputs.target_context")}`,
        `          file: ${githubExpression("steps.resolve.outputs.target_file")}`,
        "  unrelated:",
        "    steps:",
        "      - id: other",
        "        run: |",
        '          echo "context=services/docs" >> "$GITHUB_OUTPUT"',
        '          echo "dockerfile=docs/Dockerfile" >> "$GITHUB_OUTPUT"',
      ].join("\n"),
    });
    write("docker/real.Dockerfile", "FROM scratch\nCOPY . /app\n");
    write("docker/real.Dockerfile.dockerignore", "node_modules/\n");

    expect(rootContextDockerfiles(root)).toEqual(new Set(["docker/real.Dockerfile"]));
    expect(violations().join("\n")).toContain("docker/real.Dockerfile.dockerignore");
  });

  it("fails closed for lookalike runner-output redirects instead of accepting them as exact", () => {
    configureSyntheticRepository({
      workflow: [
        "jobs:",
        "  production:",
        "    steps:",
        "      - id: resolve",
        "        run: |",
        '          echo "target_context=services/docs" >> "$GITHUB_OUTPUT.evil"',
        `          echo "target_file=docs/Dockerfile" >> "${bracedShellVariable("GITHUB_OUTPUT_BACKUP")}"`,
        `          echo "target_context=." >> ${bracedShellVariable("GITHUB_OUTPUT")}`,
        `          echo "target_file=docker/Hidden.Dockerfile" >> "${bracedShellVariable("GITHUB_OUTPUT")}"`,
        '          echo "target_context=services/docs" >> "prefix$GITHUB_OUTPUT"',
        '          echo "target_file=docs/Dockerfile" >> "$GITHUB_OUTPUT.evil"',
        "      - uses: docker/build-push-action@v6",
        "        with:",
        `          context: ${githubExpression("steps.resolve.outputs.target_context")}`,
        `          file: ${githubExpression("steps.resolve.outputs.target_file")}`,
      ].join("\n"),
    });
    write("docker/Hidden.Dockerfile", "FROM scratch\nCOPY . .\n");
    write("docker/Hidden.Dockerfile.dockerignore", "node_modules/\n");

    expect(violations().join("\n")).toMatch(/unsupported.*redirect|producer.*redirect/i);
  });

  it("fails closed when an exact runner output computes a dynamic build context", () => {
    configureSyntheticRepository({
      workflow: [
        "jobs:",
        "  production:",
        "    steps:",
        "      - id: resolve",
        "        run: |",
        '          echo "target_context=$(pwd)" >> "$GITHUB_OUTPUT"',
        '          echo "target_file=Dockerfile" >> "$GITHUB_OUTPUT"',
        "      - uses: docker/build-push-action@v6",
        "        with:",
        `          context: ${githubExpression("steps.resolve.outputs.target_context")}`,
        `          file: ${githubExpression("steps.resolve.outputs.target_file")}`,
      ].join("\n"),
    });

    expect(violations().join("\n")).toMatch(/ambiguous|dynamic|unsupported/i);
  });

  it("fails closed when a referenced matrix property or step output is incomplete", () => {
    configureSyntheticRepository({
      workflow: [
        "jobs:",
        "  matrix-build:",
        "    strategy:",
        "      matrix:",
        "        include:",
        "          - target_context: .",
        "    steps:",
        "      - uses: docker/build-push-action@v6",
        "        with:",
        `          context: ${githubExpression("matrix.target_context")}`,
        `          file: ${githubExpression("matrix.target_file")}`,
        "  output-build:",
        "    steps:",
        "      - id: resolve",
        "        run: |",
        '          echo "target_context=." >> "$GITHUB_OUTPUT"',
        "      - uses: docker/build-push-action@v6",
        "        with:",
        `          context: ${githubExpression("steps.resolve.outputs.target_context")}`,
        `          file: ${githubExpression("steps.resolve.outputs.target_file")}`,
      ].join("\n"),
    });

    expect(violations().join("\n")).toMatch(/unresolved|incomplete|ambiguous/i);
  });

  it("discovers valid boolean Docker options and checks the selected override", () => {
    configureSyntheticRepository({
      workflow: ["jobs:", "  build:", "    steps:", "      - run: docker build --rm ."].join("\n"),
    });
    write("Dockerfile.dockerignore", "node_modules/\n");

    expect(rootContextDockerfiles(root)).toEqual(new Set(["Dockerfile"]));
    expect(violations().join("\n")).toContain("Dockerfile.dockerignore");
  });

  it("parses quoted continued commands and stops a build command at &&", () => {
    configureSyntheticRepository({
      workflow: [
        "jobs:",
        "  build:",
        "    steps:",
        "      - run: |",
        "          docker buildx build \\",
        '            --rm --file "docker/real.Dockerfile" \\',
        '            "." && echo done',
      ].join("\n"),
    });

    expect(rootContextDockerfiles(root)).toEqual(new Set(["docker/real.Dockerfile"]));
  });

  it("discovers Docker builds inside finite shell controls, groups, and wrappers", () => {
    const dockerfiles = [
      "docker/if.Dockerfile",
      "docker/while.Dockerfile",
      "docker/group.Dockerfile",
      "docker/subshell.Dockerfile",
      "docker/env.Dockerfile",
      "docker/not.Dockerfile",
    ];
    configureSyntheticRepository({
      workflow: [
        "jobs:",
        "  build:",
        "    steps:",
        "      - run: |",
        "          if docker build --file docker/if.Dockerfile .; then echo built; fi",
        "          while test -f marker; do docker buildx build -f docker/while.Dockerfile .; break; done",
        "          { docker build --file docker/group.Dockerfile .; }",
        "          ( docker buildx build --file docker/subshell.Dockerfile . )",
        "          DOCKER_BUILDKIT=1 command env BUILDKIT_PROGRESS=plain docker build -f docker/env.Dockerfile .",
        "          ! docker build --file docker/not.Dockerfile .",
      ].join("\n"),
    });
    for (const dockerfile of dockerfiles) {
      write(dockerfile, "FROM scratch\nCOPY . .\n");
      write(`${dockerfile}.dockerignore`, "node_modules/\n");
    }

    expect(rootContextDockerfiles(root)).toEqual(new Set(dockerfiles));
    const result = violations().join("\n");
    for (const dockerfile of dockerfiles) expect(result).toContain(`${dockerfile}.dockerignore`);
  });

  it("does not treat Docker text arguments and command queries as Docker builds", () => {
    configureSyntheticRepository({
      workflow: [
        "jobs:",
        "  docs:",
        "    steps:",
        "      - run: |",
        "          if printf '%s\\n' 'docker build --file docker/string.Dockerfile .'; then",
        "            echo docker build --file docker/echo.Dockerfile .",
        "          fi",
        "          while echo docker build --file docker/loop.Dockerfile .; do break; done",
        "          command -v docker",
        "          env | grep docker",
      ].join("\n"),
    });

    expect(rootContextDockerfiles(root)).toEqual(new Set());
    expect(violations()).toEqual([]);
  });

  it.each([
    ["eval", "eval 'docker build --file docker/eval.Dockerfile .'", "docker/eval.Dockerfile"],
    [
      "shell -c",
      "bash -c 'docker build --file docker/shell.Dockerfile .'",
      "docker/shell.Dockerfile",
    ],
    [
      "combined shell flags",
      "sh -lc 'docker build --file docker/combined.Dockerfile .'",
      "docker/combined.Dockerfile",
    ],
    [
      "absolute shell",
      "/bin/bash -lc 'docker build --file docker/absolute.Dockerfile .'",
      "docker/absolute.Dockerfile",
    ],
    [
      "absolute env and shell",
      "/usr/bin/env /bin/sh -c 'docker build --file docker/absolute-env.Dockerfile .'",
      "docker/absolute-env.Dockerfile",
    ],
    [
      "builtin eval",
      "builtin eval 'docker build --file docker/builtin.Dockerfile .'",
      "docker/builtin.Dockerfile",
    ],
    [
      "command eval",
      "command eval 'docker build --file docker/command-eval.Dockerfile .'",
      "docker/command-eval.Dockerfile",
    ],
    [
      "nested builtin command eval",
      "builtin command eval 'docker build --file docker/nested-eval.Dockerfile .'",
      "docker/nested-eval.Dockerfile",
    ],
    [
      "nested command builtin eval",
      "command builtin eval 'docker build --file docker/command-builtin.Dockerfile .'",
      "docker/command-builtin.Dockerfile",
    ],
    [
      "exec absolute shell",
      "exec /bin/bash -c 'docker build --file docker/exec-shell.Dockerfile .'",
      "docker/exec-shell.Dockerfile",
    ],
    [
      "env split-string",
      "env -S 'docker build --file docker/split.Dockerfile .'",
      "docker/split.Dockerfile",
    ],
    [
      "variable executable",
      '"$BUILD_COMMAND" build --file docker/dynamic.Dockerfile .',
      "docker/dynamic.Dockerfile",
    ],
    [
      "command-substitution executable",
      "$(printf docker) build --file docker/substitution.Dockerfile .",
      "docker/substitution.Dockerfile",
    ],
    ["dynamic Docker context", 'docker build "$(pwd)"', "Dockerfile"],
  ])("fails closed for an ambiguous dynamic shell construct: %s", (_name, command, dockerfile) => {
    configureSyntheticRepository({
      workflow: ["jobs:", "  build:", "    steps:", `      - run: ${command}`].join("\n"),
    });
    write(dockerfile, "FROM scratch\nCOPY . .\n");
    write(`${dockerfile}.dockerignore`, "node_modules/\n");

    expect(violations().join("\n")).toMatch(/ambiguous|dynamic|unsupported/i);
  });

  it("does not discover Docker builds from comments or unrelated raw text", () => {
    configureSyntheticRepository({
      workflow: [
        "jobs:",
        "  docs:",
        "    steps:",
        "      - run: |",
        "          # docker build --file docker/comment.Dockerfile .",
        "          printf '%s\\n' 'docker build --file docker/string.Dockerfile .'",
      ].join("\n"),
    });

    expect(rootContextDockerfiles(root)).toEqual(new Set());
  });

  it("does not treat quoted or commented case, interpreter, and eval text as executable", () => {
    configureSyntheticRepository({
      workflow: [
        "jobs:",
        "  docs:",
        "    steps:",
        "      - run: |",
        "          # case x in root) /bin/bash -c 'docker build .' ;; esac",
        "          printf '%s\\n' 'case x in root) docker build . ;; esac'",
        "          echo \"builtin eval 'docker build .'\"",
        "          printf '%s\\n' '/usr/bin/env bash -lc docker build .'",
      ].join("\n"),
    });

    expect(rootContextDockerfiles(root)).toEqual(new Set());
    expect(violations()).toEqual([]);
  });

  it("does not resolve action outputs from commented or quoted echo text", () => {
    configureSyntheticRepository({
      workflow: [
        "jobs:",
        "  build:",
        "    steps:",
        "      - id: resolve",
        "        run: |",
        '          # echo "target_context=." >> "$GITHUB_OUTPUT"',
        `          printf '%s\\n' 'echo "target_file=docker/fake.Dockerfile" >> "$GITHUB_OUTPUT"'`,
        "      - uses: docker/build-push-action@v6",
        "        with:",
        `          context: ${githubExpression("steps.resolve.outputs.target_context")}`,
        `          file: ${githubExpression("steps.resolve.outputs.target_file")}`,
      ].join("\n"),
    });

    expect(violations().join("\n")).toMatch(/unresolved outputs/i);
  });

  it.each(["dangling workflows directory", "intermediate directory symlink"])(
    "fails closed for a %s",
    (kind) => {
      execFileSync("git", ["init", "-q"], { cwd: root });
      write(
        ".dockerignore",
        [...REQUIRED_DOCKERIGNORE_RULES, ...RETAINED_RULES, "scratch/"].join("\n"),
      );
      write(".gitignore", [...REQUIRED_DOCKERIGNORE_RULES, ...RETAINED_RULES].join("\n"));
      write("Dockerfile", "FROM scratch\nCOPY . /app\n");
      if (kind === "dangling workflows directory") {
        mkdirSync(join(root, ".github"), { recursive: true });
        symlinkSync("missing-workflows", join(root, ".github/workflows"));
      } else {
        write("workflow-target/workflows/docker.yml", actionWorkflow());
        symlinkSync("workflow-target", join(root, ".github"));
      }

      expect(violations().join("\n")).toMatch(/workflow.*symlink|workflow.*regular directory/i);
    },
  );

  it.each([
    [
      "ambiguous expressions",
      actionWorkflow(githubExpression("inputs.dockerfile")).replace(
        "context: .",
        `context: ${githubExpression("inputs.context")}`,
      ),
    ],
    ["a parent traversal", actionWorkflow("../Dockerfile")],
    ["an absolute path", actionWorkflow("/tmp/Dockerfile")],
  ])("fails closed for %s", (_name, workflow) => {
    configureSyntheticRepository({ workflow });

    expect(violations().join("\n")).toMatch(/ambiguous|unsafe|outside|absolute/i);
  });

  it("fails closed for a root-context Dockerfile symlink", () => {
    configureSyntheticRepository({ workflow: actionWorkflow("docker/api.Dockerfile") });
    write("docker/real.Dockerfile", "FROM scratch\nCOPY . /app\n");
    symlinkSync("real.Dockerfile", join(root, "docker/api.Dockerfile"));

    expect(violations().join("\n")).toMatch(/symlink|regular file/i);
  });
});

describe("Dockerfile-specific ignore policy", () => {
  it("uses the Dockerfile-specific ignore file instead of the root file", () => {
    configureSyntheticRepository({ workflow: actionWorkflow("docker/api.Dockerfile") });
    write("docker/api.Dockerfile", "FROM scratch\nCOPY . /app\n");
    write("docker/api.Dockerfile.dockerignore", "node_modules/\n");
    write("scratch/production-signing.key");

    const result = violations().join("\n");
    expect(result).toContain("docker/api.Dockerfile.dockerignore");
    expect(result).toContain("scratch/production-signing.key");
    expect(result).toMatch(/broad COPY\/ADD/);
  });

  it("honors an override's later negation when validating sensitive names", () => {
    configureSyntheticRepository({ workflow: actionWorkflow("docker/api.Dockerfile") });
    write("docker/api.Dockerfile", "FROM scratch\nCOPY . /app\n");
    write(
      "docker/api.Dockerfile.dockerignore",
      [...REQUIRED_DOCKERIGNORE_RULES, ...RETAINED_RULES, "!scratch/production-signing.[k]ey"].join(
        "\n",
      ),
    );
    write("scratch/production-signing.key");

    expect(violations().join("\n")).toContain("scratch/production-signing.key");
  });

  it("accepts a complete effective override that excludes all sensitive names", () => {
    configureSyntheticRepository({ workflow: actionWorkflow("docker/api.Dockerfile") });
    write("docker/api.Dockerfile", "FROM scratch\nCOPY . /app\n");
    write(
      "docker/api.Dockerfile.dockerignore",
      [...REQUIRED_DOCKERIGNORE_RULES, ...RETAINED_RULES, "scratch/"].join("\n"),
    );
    write("scratch/production-signing.key");

    expect(violations()).toEqual([]);
  });

  it.each(["directory", "symlink"])("fails closed when the override is a %s", (kind) => {
    configureSyntheticRepository({ workflow: actionWorkflow("docker/api.Dockerfile") });
    write("docker/api.Dockerfile", "FROM scratch\nCOPY . /app\n");
    const override = join(root, "docker/api.Dockerfile.dockerignore");
    if (kind === "directory") mkdirSync(override, { recursive: true });
    else symlinkSync("missing-ignore", override);

    expect(violations().join("\n")).toMatch(/ignore.*regular file|ignore.*symlink/i);
  });
});

describe("broad COPY/ADD detection", () => {
  it.each([
    ["shell COPY dot", "FROM scratch\nCOPY . /app\n"],
    ["shell ADD glob", "FROM scratch\nADD ./* /app\n"],
    ["shell COPY context root", "FROM scratch\nCOPY / /app\n"],
    ["shell ADD root glob", "FROM scratch\nADD /* /app\n"],
    ["JSON COPY", 'FROM scratch\nCOPY [".", "/app"]\n'],
    ["JSON ADD glob", 'FROM scratch\nADD ["./*", "/app"]\n'],
    ["options", "FROM scratch\nCOPY --chown=1000:1000 . /app\n"],
    ["continuation", "FROM scratch\nCOPY \\\n  . \\\n  /app\n"],
    ["backtick continuation", "# escape=`\nFROM scratch\nCOPY `\n  . `\n  /app\n"],
  ])("flags %s when the effective root ignore policy is incomplete", (_name, dockerfile) => {
    configureSyntheticRepository({
      dockerfile,
      rootRules: [...REQUIRED_DOCKERIGNORE_RULES, ...RETAINED_RULES].filter(
        (rule) => rule !== "**/*.key",
      ),
    });

    expect(violations().join("\n")).toMatch(/broad COPY\/ADD/);
  });

  it.each([
    ["shell stage copy", "FROM scratch AS builder\nFROM scratch\nCOPY --from=builder . /app\n"],
    [
      "JSON stage copy",
      'FROM scratch AS builder\nFROM scratch\nCOPY --from=builder [".", "/app"]\n',
    ],
    ["specific directory", "FROM scratch\nCOPY ./src/ /app/src/\n"],
    ["specific files", "FROM scratch\nCOPY package.json pnpm-lock.yaml /app/\n"],
  ])("does not treat %s as a broad context copy", (_name, dockerfile) => {
    configureSyntheticRepository({
      dockerfile,
      rootRules: [...REQUIRED_DOCKERIGNORE_RULES, ...RETAINED_RULES].filter(
        (rule) => rule !== "**/*.key",
      ),
    });

    expect(violations().join("\n")).not.toMatch(/broad COPY\/ADD/);
  });
});
