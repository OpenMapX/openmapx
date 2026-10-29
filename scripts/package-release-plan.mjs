export const packageNames = ["@openmapx/extension-contracts", "@openmapx/extension-cli"];
export const repository = "OpenMapX/openmapx";
export const workflow = ".github/workflows/package-release.yml";
export function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const shaPattern = /^[a-f0-9]{40}$/;
export const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function validateContext(context) {
  assert(
    context?.repository === repository && shaPattern.test(context.sha),
    "Invalid source repository/SHA",
  );
  assert(
    context.ref === "refs/heads/main" &&
      context.workflowRef === `${repository}/${workflow}@refs/heads/main`,
    "Source and workflow must both be trusted main",
  );
  assert(
    [context.runId, context.attempt].every((n) => Number.isSafeInteger(n) && n > 0),
    "Invalid workflow run/attempt",
  );
}
export function validateNativePlan(nativePlan, packages, selected, packed = false) {
  assert(
    nativePlan?.version === 1 && Array.isArray(nativePlan.plan) && nativePlan.plan.length <= 2,
    "Invalid native Changesets plan version/groups",
  );
  assert(Object.keys(nativePlan).sort().join() === "plan,version", "Unexpected native plan fields");
  const seen = new Set();
  for (const group of nativePlan.plan) {
    assert(
      Array.isArray(group) && group.length > 0 && group.length <= 2,
      "Malformed native plan group",
    );
    for (const entry of group) {
      const item = packages.find((p) => p.name === entry?.name);
      assert(
        item && !item.private && selected.some((p) => p.name === entry.name),
        "Unknown/private/outside-batch native plan entry",
      );
      assert(
        entry.kind === "publish" &&
          entry.version === item.version &&
          entry.access === "public" &&
          entry.tag === "latest",
        "Unsupported native plan action/version/access/tag",
      );
      assert(!seen.has(entry.name), "Duplicate native plan entry");
      seen.add(entry.name);
      const keys = ["access", "kind", "name", "tag", "version", ...(packed ? ["tarball"] : [])]
        .sort()
        .join();
      assert(Object.keys(entry).sort().join() === keys, "Unexpected native plan entry fields");
      if (packed) {
        assert(
          Object.keys(entry.tarball ?? {})
            .sort()
            .join() === "integrity,path",
          "Malformed tarball plan",
        );
        assert(/^packages\/[a-z0-9.-]+\.tgz$/.test(entry.tarball.path), "Unsafe tarball plan path");
        assert(
          /^sha256-[A-Za-z0-9+/]{43}=$/.test(entry.tarball.integrity),
          "Invalid native tarball integrity",
        );
      }
    }
  }
  return [...seen];
}

/** No registry-derived fallback may enlarge a reviewed version batch. */
export function planPackageRelease(input) {
  const { context, packages, operation, ci, pr, canonical } = input;
  validateContext(context);
  assert(["qualify", "publish"].includes(operation), "Invalid package operation");
  assert(
    input.toolVersion === "3.0.3",
    "Experimental native plan requires installed Changesets 3.0.3",
  );
  assert(
    Array.isArray(packages) &&
      packages.length === 2 &&
      new Set(packages.map((p) => p.name)).size === 2,
    "Changed qualified public allowlist",
  );
  for (const item of packages) {
    assert(
      packageNames.includes(item.name) &&
        item.directory === `packages/${item.name.split("/")[1]}` &&
        !item.private &&
        versionPattern.test(item.version),
      "Changed qualified public allowlist/manifest",
    );
    // Today both artifacts are self-contained. A future public dependency graph
    // needs explicit closure/ordering support instead of silently dropping nodes.
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, range] of Object.entries(item[field] ?? {}))
        assert(
          !name.startsWith("@openmapx/") && !String(range).startsWith("workspace:"),
          "Unsupported public runtime dependency topology; qualify closure and dependency order first",
        );
    }
  }
  assert(
    Array.isArray(input.pending) && input.pending.length === 0,
    "Pending qualified Changesets require a deliberate version batch first",
  );
  let selected = packages;
  let versionPr = null;
  let sourceCI = null;
  if (operation === "publish") {
    assert(
      Number.isSafeInteger(input.sourceRunId) &&
        input.sourceRunId > 0 &&
        ci?.id === input.sourceRunId,
      "Wrong source CI run",
    );
    assert(
      ci.path === ".github/workflows/ci.yml" &&
        ci.head_sha === context.sha &&
        ci.head_branch === "main" &&
        ["push", "schedule"].includes(ci.event),
      "CI must be trusted main for the exact dispatch source/workflow",
    );
    assert(
      ci.repository?.full_name === repository && ci.head_repository?.full_name === repository,
      "Foreign/fork CI run",
    );
    assert(
      ci.status === "completed" &&
        ci.conclusion === "success" &&
        Number.isSafeInteger(ci.run_attempt) &&
        ci.run_attempt > 0,
      "Incomplete/unsuccessful CI attempt",
    );
    assert(
      Number.isSafeInteger(input.versionPr) &&
        input.versionPr > 0 &&
        pr?.number === input.versionPr &&
        pr.merged === true,
      "A merged version PR is required",
    );
    assert(
      pr.base?.ref === "main" &&
        pr.base?.repo?.full_name === repository &&
        pr.head?.repo?.full_name === repository &&
        shaPattern.test(pr.head.sha) &&
        shaPattern.test(pr.merge_commit_sha),
      "Wrong version PR source/target",
    );
    assert(
      canonical?.valid === true &&
        canonical.reachable === true &&
        canonical.mergeSha === pr.merge_commit_sha &&
        canonical.headSha === pr.head.sha,
      "Version PR must be canonical and reachable from source",
    );
    assert(
      Array.isArray(canonical.packages) &&
        canonical.packages.length > 0 &&
        new Set(canonical.packages.map((p) => p.name)).size === canonical.packages.length,
      "Empty/duplicate canonical package batch",
    );
    selected = canonical.packages.map((entry) => {
      const item = packages.find((p) => p.name === entry.name);
      assert(
        item && item.version === entry.version,
        "Current versions differ from canonical batch",
      );
      return item;
    });
    versionPr = { number: pr.number, mergeSha: pr.merge_commit_sha, headSha: pr.head.sha };
    sourceCI = { runId: ci.id, attempt: ci.run_attempt };
  }
  validateNativePlan(input.nativePlan, packages, selected);
  return {
    operation,
    context,
    sourceCI,
    versionPr,
    toolVersion: input.toolVersion,
    selected,
    consumers: packages,
  };
}
