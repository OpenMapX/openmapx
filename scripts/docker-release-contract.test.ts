import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

describe("Docker release trust gate", () => {
  const release = read(".github/workflows/docker.yml");
  const ci = read(".github/workflows/ci.yml");

  it("starts publication only after successful CI for the current trusted main commit", () => {
    expect(release).toContain("workflow_call:");
    expect(release).not.toContain("workflow_run:");
    expect(release).not.toContain("workflow_dispatch:");
    expect(ci).toMatch(/^ {2}release:\n/m);
    expect(ci).toContain("needs: ci");
    expect(ci).toContain("needs.ci.result == 'success'");
    expect(ci).toContain("github.event_name == 'push'");
    expect(ci).toContain("github.ref == 'refs/heads/main'");
    expect(ci).toContain("uses: ./.github/workflows/docker.yml");
    expect(release).toContain('context.eventName !== "push"');
    expect(release).toContain('context.ref !== "refs/heads/main"');
    expect(release).toContain("const candidate = context.sha");
    expect(release).toContain("heads/main");
  });

  it("pushes untagged candidates, audits all findings, and gates actionable findings", () => {
    expect(release).toContain("push-by-digest=true");
    expect(release).toContain("name-canonical=true");
    expect(release).toContain(["@", "$", "{{ steps.build.outputs.digest }}"].join(""));
    expect(release).toContain("severity: CRITICAL,HIGH");
    expect(release).toContain("- name: Audit exact candidate digest with Trivy");
    expect(release).toContain('ignore-unfixed: "false"');
    expect(release).toContain('exit-code: "0"');
    expect(release).toContain("- name: Gate exact candidate digest with Trivy");
    expect(release).toContain('ignore-unfixed: "true"');
    expect(release).toContain("trivyignores: .trivyignore.yaml");
    expect(release).toContain('exit-code: "1"');
    const ignorePolicy = read(".trivyignore.yaml");
    expect(ignorePolicy).toContain('paths: ["usr/local/bin/docker"]');
    expect(ignorePolicy).toContain('paths: ["usr/local/lib/docker/cli-plugins/docker-compose"]');
    expect(ignorePolicy).toContain("expired_at:");

    const gateStart = release.indexOf("- name: Gate exact candidate digest with Trivy");
    const gateEnd = release.indexOf("- name:", gateStart + 10);
    expect(gateStart).toBeGreaterThan(-1);
    expect(release.slice(gateStart, gateEnd)).not.toContain("ENABLE_CODE_SCANNING");
  });

  it("publishes immutable image tags before advancing the complete release pointer", () => {
    expect(release).toMatch(/^ {2}promote:\n/m);
    expect(release).toContain("needs: [gate, build]");
    expect(release).toContain("RELEASE_MANIFEST_IMAGE");
    expect(release).toContain("release-manifest.json");
    expect(release).toContain("docker buildx imagetools create");
    expect(release).toContain("${" + "RELEASE_SHA}");
    expect(release).toContain('"$' + '{RELEASE_MANIFEST_IMAGE}:latest"');

    const build = release.indexOf("push-by-digest=true");
    const scan = release.indexOf("Gate exact candidate digest with Trivy");
    const immutablePromotion = release.indexOf('"$' + "{IMAGE}:$" + '{RELEASE_SHA}"');
    const releasePointer = release.indexOf('"$' + '{RELEASE_MANIFEST_IMAGE}:latest"');
    expect(build).toBeLessThan(scan);
    expect(scan).toBeLessThan(immutablePromotion);
    expect(immutablePromotion).toBeLessThan(releasePointer);

    const promoteStart = release.indexOf("  promote:\n");
    const promoteJob = release.slice(promoteStart);
    expect(promoteJob).not.toContain("matrix:");
    expect(promoteJob).not.toContain('"$' + '{IMAGE}:latest"');
  });

  it("writes parseable release JSON even when Docker promotion commands write to stdout", () => {
    const promotionStart = release.indexOf(
      "- name: Promote every scanned digest to SHA and assemble the release manifest",
    );
    const promotionEnd = release.indexOf(
      "- name: Publish the immutable release manifest",
      promotionStart,
    );
    const promotionStep = release.slice(promotionStart, promotionEnd);
    const run = promotionStep.match(/ {8}run: \|\n([\s\S]*)/)?.[1];
    if (run === undefined) throw new Error("promotion step is missing its shell script");
    const script = run
      .split("\n")
      .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
      .join("\n");

    const temp = mkdtempSync(join(tmpdir(), "openmapx-release-contract-"));
    try {
      const bin = join(temp, "bin");
      mkdirSync(bin);
      for (const app of [
        "api",
        "web",
        "data-manager",
        "ops-agent",
        "transitous-runner",
        "transitous-tools",
        "docs",
      ]) {
        const digestDir = join(temp, "digests", `docker-digest-${app}-1-1`);
        mkdirSync(digestDir, { recursive: true });
        writeFileSync(join(digestDir, "a".repeat(64)), "");
      }
      const docker = join(bin, "docker");
      writeFileSync(
        docker,
        '#!/usr/bin/env sh\nif [ "$3" = "inspect" ]; then echo "promotion inspection output"; fi\n',
      );
      chmodSync(docker, 0o755);
      const scriptPath = join(temp, "promote.sh");
      writeFileSync(scriptPath, script);

      execFileSync("bash", ["-eu", scriptPath], {
        cwd: temp,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GITHUB_RUN_ID: "1",
          GITHUB_RUN_ATTEMPT: "1",
          IMAGE_PREFIX: "example.invalid/openmapx",
          RELEASE_MANIFEST_IMAGE: "example.invalid/openmapx/release-manifest",
          RELEASE_SHA: "a".repeat(40),
        },
      });

      expect(
        JSON.parse(readFileSync(join(temp, "release-manifest", "release-manifest.json"), "utf8")),
      ).toEqual({
        schemaVersion: 1,
        release: "a".repeat(40),
        images: {
          api: `example.invalid/openmapx/api@sha256:${"a".repeat(64)}`,
          web: `example.invalid/openmapx/web@sha256:${"a".repeat(64)}`,
          "data-manager": `example.invalid/openmapx/data-manager@sha256:${"a".repeat(64)}`,
          "ops-agent": `example.invalid/openmapx/ops-agent@sha256:${"a".repeat(64)}`,
          "transitous-runner": `example.invalid/openmapx/transitous-runner@sha256:${"a".repeat(64)}`,
          "transitous-tools": `example.invalid/openmapx/transitous-tools@sha256:${"a".repeat(64)}`,
          docs: `example.invalid/openmapx/docs@sha256:${"a".repeat(64)}`,
        },
      });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("requires one canonical digest artifact per image and a fail-closed docs image reference", () => {
    expect(release).toContain('[[ ! "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]');
    expect(release).toContain(
      'digest_files=("digests/docker-digest-$' +
        "{app}-$" +
        "{GITHUB_RUN_ID}-$" +
        '{GITHUB_RUN_ATTEMPT}"/*)',
    );
    expect(release).toContain(
      '[ "$' + '{#digest_files[@]}" -ne 1 ] || [ ! -f "$' + '{digest_files[0]}" ]',
    );

    const docsReadme = read("docs/README.md");
    expect(docsReadme).toContain('if ! OPENMAPX_DOCS_IMAGE="$(jq -er');
    expect(docsReadme).toContain("^ghcr\\.io/openmapx/docs@sha256:[0-9a-f]{64}$");
    expect(docsReadme).toContain("export OPENMAPX_DOCS_IMAGE");
  });

  it("builds only affected deployable Docker targets without publishing on pull requests", () => {
    expect(ci).toMatch(/^ {2}docker-changes:\n/m);
    expect(ci).toContain("dorny/paths-filter@");
    expect(ci).toContain(`apps: \${{ steps.filter.outputs.changes }}`);
    expect(ci).toMatch(/^ {2}docker-build:\n/m);
    expect(ci).toContain(`app: \${{ fromJSON(needs.docker-changes.outputs.apps) }}`);
    expect(ci).toContain("needs: docker-changes");
    expect(ci).toContain("needs.docker-changes.outputs.apps != '[]'");
    expect(ci).toContain("push: false");
    expect(ci).toMatch(/needs: \[[^\]]*docker-build[^\]]*\]/);
    expect(read("apps/web/Dockerfile")).toContain(
      "COPY apps/api/openapi.json apps/api/openapi.json",
    );
    for (const dockerfile of [
      "apps/api/Dockerfile",
      "apps/web/Dockerfile",
      "services/data-manager/Dockerfile",
    ]) {
      expect(read(dockerfile)).toContain("rm -rf /usr/local/lib/node_modules/npm");
    }
    for (const dockerfile of ["apps/api/Dockerfile", "services/data-manager/Dockerfile"]) {
      expect(read(dockerfile)).toContain("image-size@*");
    }
    for (const dockerfile of [
      "apps/transitous-runner/Dockerfile",
      "services/data-manager/Dockerfile",
      "services/motis/tools/transitous/Dockerfile",
    ]) {
      expect(read(dockerfile)).toContain("golang.org/x/text@v0.39.0");
    }
  });
});
