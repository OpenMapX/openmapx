// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: manual Actions IO adapter does not run as a cached Turbo task.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert } from "./product-release-config.mjs";
import { canonicalCandidate, digestPattern } from "./product-release-plan.mjs";

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}
function api(path, method = "GET", body) {
  return JSON.parse(
    run(
      "gh",
      ["api", path, "--method", method, ...(body ? ["--input", "-"] : [])],
      body ? { input: JSON.stringify(body), stdio: ["pipe", "pipe", "pipe"] } : {},
    ),
  );
}
function optionalApi(path) {
  try {
    return api(path);
  } catch (error) {
    if (/HTTP 404/.test(String(error.stderr))) {
      const repository = api(`repos/${process.env.GITHUB_REPOSITORY}`);
      assert(repository.permissions?.push === true, "Repository push access is required");
      return null;
    }
    throw error;
  }
}
function registryDigest(reference, optional = false) {
  const result = spawnSync(
    "docker",
    ["buildx", "imagetools", "inspect", reference, "--format", "{{.Manifest.Digest}}"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    if (
      optional &&
      /manifest unknown|MANIFEST_UNKNOWN|not found/.test(result.stderr ?? "") &&
      !/unauthorized|denied|timeout|connection/i.test(result.stderr ?? "")
    )
      return null;
    throw new Error(`Cannot inspect ${reference}: ${result.stderr}`);
  }
  const digest = result.stdout.trim();
  assert(digestPattern.test(digest), "Invalid registry digest");
  return digest;
}
export function createReleasePorts() {
  const repository = process.env.GITHUB_REPOSITORY;
  assert(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? ""),
    "Missing workflow repository",
  );
  const prefix = `ghcr.io/${repository.toLowerCase().split("/")[0]}`;
  const metadataRepository = `${prefix}/release-manifest`;
  const extractManifest = (digest) => {
    assert(digestPattern.test(digest), "Invalid manifest digest");
    const reference = `${metadataRepository}@${digest}`;
    run("docker", ["pull", reference]);
    const imageId = run("docker", ["image", "inspect", "--format", "{{.Id}}", reference]);
    assert(digestPattern.test(imageId), "Invalid local manifest image ID");
    const container = run("docker", ["create", imageId, "true"]);
    assert(/^[a-f0-9]{64}$/.test(container), "Invalid metadata container");
    const temp = mkdtempSync(join(tmpdir(), "openmapx-named-extract-"));
    try {
      run("docker", ["cp", `${container}:/release-manifest.json`, join(temp, "manifest.json")]);
      return JSON.parse(readFileSync(join(temp, "manifest.json"), "utf8"));
    } finally {
      try {
        run("docker", ["rm", "-f", container]);
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    }
  };
  const source = (revision, path) => {
    assert(
      /^[a-f0-9]{40}$/.test(revision) &&
        /^(scripts\/product-release\.json|docs\/docs\/releases\/[0-9A-Za-z.-]+\.md)$/.test(path),
      "Invalid source data path",
    );
    const value = api(`repos/${repository}/contents/${path}?ref=${revision}`);
    assert(
      value.type === "file" && value.encoding === "base64" && value.size < 1024 * 1024,
      "Invalid source data",
    );
    return Buffer.from(value.content, "base64").toString("utf8");
  };
  const releases = () =>
    JSON.parse(
      run("gh", ["api", `repos/${repository}/releases?per_page=100`, "--paginate", "--slurp"]),
    ).flat();
  const draft = async (version, id) => {
    // The tag endpoint excludes drafts. Listing requires push access and includes pending tags.
    const matches = id
      ? [api(`repos/${repository}/releases/${id}`)]
      : releases().filter((value) => value.tag_name === version);
    assert(matches.length <= 1, "Ambiguous release version");
    const release = matches[0];
    if (!release) return null;
    assert(
      release.tag_name === version && Number.isSafeInteger(release.id) && release.id > 0,
      "Release ID changed version or is invalid",
    );
    const assets = {};
    for (const asset of release.assets) {
      assert(
        /^[A-Za-z0-9._-]+$/.test(asset.name) && asset.size < 2 * 1024 * 1024,
        "Unsafe release asset",
      );
      assert(assets[asset.name] === undefined, "Duplicate release asset");
      assets[asset.name] = execFileSync(
        "gh",
        [
          "api",
          `repos/${repository}/releases/assets/${asset.id}`,
          "-H",
          "Accept: application/octet-stream",
        ],
        { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
      );
    }
    return {
      id: release.id,
      url: release.html_url,
      version: release.tag_name,
      target: release.target_commitish,
      name: release.name,
      body: release.body,
      draft: release.draft,
      prerelease: release.prerelease,
      immutable: release.immutable,
      assets,
    };
  };
  const verifyTagTarget = async (version, revision, mode = "check") => {
    const tag = optionalApi(`repos/${repository}/git/ref/tags/${version}`);
    if (!tag) {
      assert(mode !== "require", "Published release tag is missing");
      if (mode === "create")
        api(`repos/${repository}/git/refs`, "POST", { ref: `refs/tags/${version}`, sha: revision });
      return;
    }
    let object = tag.object;
    let depth = 0;
    while (object.type === "tag" && depth++ < 5)
      object = api(`repos/${repository}/git/tags/${object.sha}`).object;
    assert(
      object.type === "commit" && object.sha === revision,
      "Version tag points at another source",
    );
  };
  return {
    repository,
    ref: process.env.GITHUB_REF,
    extractManifest,
    draft,
    verifyTagTarget,
    async verifyEnvironment() {
      const environment = api(`repos/${repository}/environments/named-release`);
      const review = environment.protection_rules?.find(
        (rule) => rule.type === "required_reviewers",
      );
      const policies = api(
        `repos/${repository}/environments/named-release/deployment-branch-policies`,
      );
      assert(
        review?.prevent_self_review === false &&
          review.reviewers?.some(
            (item) => item.type === "User" && item.reviewer?.id === 37375186,
          ) &&
          environment.deployment_branch_policy?.custom_branch_policies === true &&
          environment.deployment_branch_policy?.protected_branches === false &&
          policies.branch_policies?.length === 1 &&
          policies.branch_policies[0].name === "main" &&
          policies.branch_policies[0].type === "branch",
        "named-release environment protection differs from approved owner/main policy",
      );
    },
    async producer(id, recorded) {
      assert(Number.isSafeInteger(id) && id > 0, "Invalid producer run ID");
      let runData;
      if (!recorded) {
        runData = api(`repos/${repository}/actions/runs/${id}`);
        const configuration = JSON.parse(source(runData.head_sha, "scripts/product-release.json"));
        const existing = await draft(`v${configuration.version}`);
        if (existing?.assets["candidate.json"]) {
          const envelope = JSON.parse(existing.assets["candidate.json"]);
          assert(
            envelope.candidate?.manifest?.producer?.runId === id,
            "Existing version selects another producer",
          );
          recorded = {
            attempt: envelope.candidate.manifest.producer.runAttempt,
            digest: envelope.candidate.producerManifestDigest,
          };
        }
      }
      if (recorded) {
        assert(
          Number.isSafeInteger(recorded.attempt) &&
            recorded.attempt > 0 &&
            digestPattern.test(recorded.digest),
          "Invalid frozen producer receipt",
        );
        runData = api(`repos/${repository}/actions/runs/${id}/attempts/${recorded.attempt}`);
        assert(runData.run_attempt === recorded.attempt, "Producer attempt changed");
      }
      const pages = JSON.parse(
        run("gh", [
          "api",
          `repos/${repository}/actions/runs/${id}/attempts/${runData.run_attempt}/jobs?per_page=100`,
          "--paginate",
          "--slurp",
        ]),
      );
      const configuration = JSON.parse(source(runData.head_sha, "scripts/product-release.json"));
      const notes = source(runData.head_sha, configuration.notesPath);
      const digest =
        recorded?.digest ??
        registryDigest(`${metadataRepository}:${runData.head_sha}-${id}-${runData.run_attempt}`);
      return {
        repository,
        configuration,
        notes,
        run: runData,
        jobs: pages.flatMap((page) => page.jobs),
        producerManifestDigest: digest,
        producerManifest: extractManifest(digest),
      };
    },
    async packageManifest(manifest, hash) {
      const tag = `${metadataRepository}:candidate-${hash}`;
      const existing = registryDigest(tag, true);
      if (existing) {
        assert(
          canonicalCandidate(extractManifest(existing)) === canonicalCandidate(manifest),
          "Candidate tag content conflicts",
        );
        return existing;
      }
      const temp = mkdtempSync(join(tmpdir(), "openmapx-named-package-"));
      try {
        writeFileSync(join(temp, "release-manifest.json"), `${canonicalCandidate(manifest)}\n`);
        writeFileSync(
          join(temp, "Dockerfile"),
          "FROM scratch\nCOPY release-manifest.json /release-manifest.json\n",
        );
        run("docker", [
          "buildx",
          "build",
          "--platform",
          "linux/amd64",
          "--provenance=false",
          "--sbom=false",
          "--build-arg",
          "SOURCE_DATE_EPOCH=0",
          "--tag",
          tag,
          "--push",
          temp,
        ]);
        return registryDigest(tag);
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
    async mutationAuthority(target) {
      const repo = api(`repos/${repository}`);
      assert(repo.default_branch === "main", "Default branch differs from release policy");
      const head = api(`repos/${repository}/git/ref/heads/main`).object;
      const workflows = (revision) => {
        const tree = api(`repos/${repository}/git/trees/${revision}?recursive=1`);
        assert(tree.truncated === false, "Cannot establish workflow parity from a truncated tree");
        return tree.tree
          .filter((item) => item.type === "blob" && item.path.startsWith(".github/workflows/"))
          .map(({ path, sha, mode }) => ({ path, sha, mode }))
          .sort((a, b) => a.path.localeCompare(b.path));
      };
      return {
        automated:
          canonicalCandidate(workflows(target)) === canonicalCandidate(workflows(head.sha)),
        defaultRevision: head.sha,
        target,
      };
    },
    ownerHandoff({
      operation,
      target,
      version,
      id,
      assets,
      candidateHash,
      approvalHash,
      authority,
      snapshot,
      candidateManifestDigest,
    }) {
      candidateManifestDigest ??= assets?.["candidate.json"]
        ? JSON.parse(assets["candidate.json"]).candidateManifestDigest
        : undefined;
      const body =
        operation === "prepare"
          ? {
              tag_name: version,
              target_commitish: target,
              name: version,
              draft: true,
              prerelease: true,
              body: assets["notes.md"],
            }
          : { draft: false, prerelease: true, make_latest: "false" };
      return {
        status: "owner-action-required",
        handoff: {
          operation,
          repository,
          target,
          version,
          draftId: id,
          candidateHash,
          candidateManifestDigest,
          approvalHash,
          authority,
          snapshot,
          command: `gh api repos/${repository}/releases${id ? `/${id}` : ""} --method ${operation === "prepare" ? "POST" : "PATCH"} --input request.json`,
          request: {
            method: operation === "prepare" ? "POST" : "PATCH",
            path: `repos/${repository}/releases${id ? `/${id}` : ""}`,
            body,
          },
          instructions:
            "Use existing maintainer gh authority to review and perform this exact request. No new token is needed. Manual publication is the owner's final publication approval; the script cannot enforce approval outside Actions. Retry the same operation afterward to verify exact content and resume; preview remains unchanged until verification.",
        },
      };
    },
    async writeDraft(value) {
      let existing = await draft(value.version, value.id);
      if (!existing) {
        const envelope = JSON.parse(value.assets["candidate.json"]);
        const authority = await this.mutationAuthority(value.target);
        if (!authority.automated)
          return this.ownerHandoff({
            operation: "prepare",
            ...value,
            candidateHash: envelope.candidateHash,
            authority,
          });
        const created = api(`repos/${repository}/releases`, "POST", {
          tag_name: value.version,
          target_commitish: value.target,
          name: value.version,
          draft: true,
          prerelease: true,
          body: value.assets["notes.md"],
        });
        existing = await draft(value.version, created.id);
      }
      assert(
        existing.draft &&
          existing.target === value.target &&
          existing.name === value.version &&
          existing.body === value.assets["notes.md"],
        "Cannot alter published/conflicting release",
      );
      const temp = mkdtempSync(join(tmpdir(), "openmapx-named-upload-"));
      try {
        for (const [name, bytes] of Object.entries(value.assets)) {
          assert(/^[A-Za-z0-9._-]+$/.test(name), "Unsafe upload name");
          if (existing.assets[name] !== undefined) {
            assert(existing.assets[name] === bytes, `Conflicting draft asset ${name}`);
            continue;
          }
          const path = join(temp, name);
          writeFileSync(path, bytes);
          run("gh", [
            "api",
            `https://uploads.github.com/repos/${repository}/releases/${existing.id}/assets?name=${encodeURIComponent(name)}`,
            "--method",
            "POST",
            "-H",
            "Content-Type: application/octet-stream",
            "--input",
            path,
          ]);
        }
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
      const readback = await draft(value.version, existing.id);
      assert(
        readback?.draft &&
          readback.target === value.target &&
          readback.name === value.version &&
          readback.body === value.assets["notes.md"],
        "Draft readback changed public content",
      );
      for (const [name, bytes] of Object.entries(value.assets))
        assert(readback.assets[name] === bytes, `Draft upload readback mismatch: ${name}`);
      return readback;
    },
    async scan(image) {
      run("trivy", [
        "image",
        "--scanners",
        "vuln",
        "--vuln-type",
        "os,library",
        "--severity",
        "HIGH,CRITICAL",
        "--ignore-unfixed",
        "--ignorefile",
        ".trivyignore.yaml",
        "--exit-code",
        "1",
        image,
      ]);
    },
    async requireAlias(destination, digest) {
      assert(
        registryDigest(destination, true) === digest,
        `Published version alias missing or changed: ${destination}`,
      );
    },
    async tag(destination, digest) {
      const old = registryDigest(destination, true);
      if (old) {
        assert(old === digest, `Version image conflict: ${destination}`);
        return;
      }
      const image = destination.slice(0, destination.lastIndexOf(":"));
      run("docker", [
        "buildx",
        "imagetools",
        "create",
        "--prefer-index=false",
        "--tag",
        destination,
        `${image}@${digest}`,
      ]);
      assert(registryDigest(destination) === digest, "Promoted image digest mismatch");
    },
    async preview() {
      const digest = registryDigest(`${metadataRepository}:preview`, true);
      if (!digest) return null;
      const manifest = extractManifest(digest);
      assert(
        manifest.product && manifest.release === `v${manifest.product.version}`,
        "Preview is not a named release",
      );
      return { version: manifest.release, digest };
    },
    async advancePreview({ digest }) {
      run("docker", [
        "buildx",
        "imagetools",
        "create",
        "--prefer-index=false",
        "--tag",
        `${metadataRepository}:preview`,
        `${metadataRepository}@${digest}`,
      ]);
      assert(registryDigest(`${metadataRepository}:preview`) === digest, "Preview digest mismatch");
    },
    async publish(value) {
      api(`repos/${repository}/releases/${value.id}`, "PATCH", {
        draft: false,
        prerelease: true,
        make_latest: "false",
      });
    },
    async verifyPublished(version, candidate, expected) {
      const assets = expected.assets;
      const published = await draft(version);
      assert(
        published &&
          !published.draft &&
          published.immutable === true &&
          published.target === candidate.sourceRevision &&
          published.id === expected.id &&
          published.name === expected.name &&
          published.body === expected.body &&
          published.prerelease === expected.prerelease,
        "Published release is not immutable or has the wrong target",
      );
      assert(
        canonicalCandidate(published.assets) === canonicalCandidate(assets),
        "Published asset integrity mismatch",
      );
      await verifyTagTarget(version, candidate.sourceRevision, "require");
      run("gh", ["release", "verify", version, "--repo", repository, "--format", "json"]);
      const temp = mkdtempSync(join(tmpdir(), "openmapx-release-attestation-"));
      try {
        for (const [name, bytes] of Object.entries(assets)) {
          const path = join(temp, name);
          writeFileSync(path, bytes);
          run("gh", [
            "release",
            "verify-asset",
            version,
            path,
            "--repo",
            repository,
            "--format",
            "json",
          ]);
        }
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  };
}
