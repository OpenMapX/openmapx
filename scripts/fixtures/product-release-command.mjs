#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: subprocess-only synthetic systems use a private test state path.
// Executable synthetic external systems for the real release IO adapter. Never contacts a service.
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const path = process.env.SYNTHETIC_STATE;
const state = JSON.parse(readFileSync(path, "utf8"));
const args = process.argv.slice(2);
const command = basename(process.argv[1]);
const save = () => writeFileSync(path, JSON.stringify(state));
const out = (value) => {
  save();
  console.log(typeof value === "string" ? value : JSON.stringify(value));
};
const fail = (message) => {
  save();
  console.error(message);
  process.exit(1);
};
state.calls.push({ command, args });
function mutate(point) {
  if (state.mutation?.point !== point) return;
  const { field } = state.mutation;
  if (field === "readiness.json") state.release.assets[field] += " ";
  else state.release[field] += " changed";
  delete state.mutation;
}
function release() {
  if (!state.release) return null;
  return {
    ...state.release,
    assets: Object.entries(state.release.assets).map(([name, bytes], i) => ({
      name,
      id: i + 100,
      size: Buffer.byteLength(bytes),
    })),
  };
}
if (command === "gh") {
  if (args[0] === "release") {
    out({ verified: true });
  } else {
    const uploadPrefix = "https://uploads.github.com/";
    const endpoint = args[1].startsWith(uploadPrefix)
      ? args[1].slice(uploadPrefix.length)
      : args[1];
    if (endpoint !== "repos/OpenMapX/openmapx" && !endpoint.startsWith("repos/OpenMapX/openmapx/"))
      fail("Unsupported synthetic endpoint");
    const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
    if (state.authError && endpoint.includes("/releases?"))
      fail(`HTTP ${state.authError}: inaccessible releases`);
    const input = args.includes("--input")
      ? readFileSync(
          args[args.indexOf("--input") + 1] === "-" ? 0 : args[args.indexOf("--input") + 1],
          "utf8",
        )
      : "";
    const body = input && !endpoint.includes("/assets?") ? JSON.parse(input) : null;
    if (endpoint.endsWith("/environments/named-release"))
      out({
        protection_rules: [
          {
            type: "required_reviewers",
            prevent_self_review: false,
            reviewers: [{ type: "User", reviewer: { id: 37375186 } }],
          },
        ],
        deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
      });
    else if (endpoint.endsWith("/deployment-branch-policies"))
      out({ branch_policies: [{ name: "main", type: "branch" }] });
    else if (endpoint === "repos/OpenMapX/openmapx")
      out({ default_branch: "main", permissions: { push: true } });
    else if (endpoint.includes("/git/trees/"))
      out({
        truncated: false,
        tree: [
          {
            path: ".github/workflows/ci.yml",
            type: "blob",
            sha:
              endpoint.includes(state.input.run.head_sha) || !state.parityMismatch
                ? "1".repeat(40)
                : "2".repeat(40),
          },
        ],
      });
    else if (endpoint.endsWith("/git/ref/heads/main"))
      out({ object: { sha: "f".repeat(40), type: "commit" } });
    else if (endpoint.includes("/actions/runs/")) {
      const attempt = Number(endpoint.match(/attempts\/(\d+)/)?.[1] ?? state.latestAttempt);
      const run = {
        ...state.input.run,
        run_attempt: attempt,
        conclusion: attempt === 3 ? "failure" : "success",
      };
      if (endpoint.includes("/jobs")) out([{ jobs: state.input.jobs }]);
      else out(run);
    } else if (endpoint.includes("/contents/")) {
      const bytes = endpoint.includes("product-release.json")
        ? JSON.stringify(state.input.configuration)
        : state.input.notes;
      out({
        type: "file",
        size: bytes.length,
        encoding: "base64",
        content: Buffer.from(bytes).toString("base64"),
      });
    } else if (endpoint.includes("/git/ref/tags/")) {
      if (!state.tag) fail("HTTP 404");
      else out({ object: { type: "commit", sha: state.tag } });
    } else if (endpoint.endsWith("/git/refs") && method === "POST") {
      state.tag = body.sha;
      out({});
    } else if (endpoint.includes("/releases/assets/")) {
      const i = Number(endpoint.split("/").at(-1)) - 100;
      save();
      process.stdout.write(Object.values(state.release.assets)[i]);
    } else if (endpoint.includes("/releases/tags/")) {
      if (!state.release || state.release.draft) fail("HTTP 404");
      else out(release());
    } else if (/\/releases\?/.test(endpoint)) out([[], [...(state.release ? [release()] : [])]]);
    else if (endpoint.endsWith("/releases") && method === "POST") {
      if (state.parityMismatch) fail("HTTP 403: workflow permission required");
      state.release = {
        id: 42,
        html_url: "https://example.invalid/draft/42",
        tag_name: body.tag_name,
        target_commitish: body.target_commitish,
        name: body.name,
        body: body.body,
        draft: true,
        prerelease: true,
        assets: {},
      };
      out(release());
    } else if (endpoint.includes("/releases/42/assets?") && method === "POST") {
      state.release.assets[decodeURIComponent(endpoint.split("name=")[1])] = input;
      out({});
    } else if (endpoint.endsWith("/releases/42") && method === "PATCH") {
      if (state.parityMismatch) fail("HTTP 403: workflow permission required");
      state.release.draft = false;
      state.release.immutable = true;
      state.tag = state.release.target_commitish;
      state.published++;
      out(release());
    } else if (endpoint.endsWith("/releases/42")) out(release());
    else fail(`Unsupported synthetic gh endpoint ${endpoint}`);
  }
} else if (command === "docker") {
  if (args[0] === "pull") out("pulled");
  else if (args[0] === "image") out(args.at(-1).split("@")[1]);
  else if (args[0] === "create") {
    state.containerDigest = args[1];
    out("a".repeat(64));
  } else if (args[0] === "cp") {
    writeFileSync(args.at(-1), JSON.stringify(state.manifests[state.containerDigest]));
    out("");
  } else if (args[0] === "rm") out("");
  else if (args[1] === "build") {
    const tag = args[args.indexOf("--tag") + 1];
    const digest = `sha256:${"e".repeat(64)}`;
    state.registry[tag] = digest;
    state.manifests[digest] = JSON.parse(
      readFileSync(join(args.at(-1), "release-manifest.json"), "utf8"),
    );
    out("");
  } else if (args[2] === "inspect") {
    const digest = state.registry[args[3]];
    if (!digest) fail("manifest unknown");
    out(digest);
  } else if (args[2] === "create") {
    const tag = args[args.indexOf("--tag") + 1];
    if (tag.endsWith(":preview") && state.previewFailure) fail("synthetic preview outage");
    state.registry[tag] = args.at(-1).split("@")[1];
    mutate("tag");
    out("");
  } else fail("Unsupported synthetic docker command");
} else if (command === "trivy") {
  mutate("scan");
  out("passed");
} else fail(`Unsupported synthetic command ${command}`);
