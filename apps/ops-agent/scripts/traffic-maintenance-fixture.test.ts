import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { withPrivateFixture } from "./traffic-maintenance-fixture.ts";

let workspace: string;
let root: string;
let shared: string;
let executions: number;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "openmapx-maintenance-preflight-"));
  root = join(workspace, "fixture");
  shared = join(root, "valhalla", "osm-pbf");
  mkdirSync(shared, { recursive: true });
  chmodSync(root, 0o700);
  executions = 0;
});
afterEach(() => rmSync(workspace, { recursive: true, force: true }));

async function inspectFixture(path = root, child = shared, uid = process.geteuid?.()) {
  return withPrivateFixture(
    path,
    child,
    async (resolvedChild) => {
      executions++;
      return resolvedChild;
    },
    uid,
  );
}

async function rejectsBeforeDocker(path = root, child = shared, uid = process.geteuid?.()) {
  await assert.rejects(inspectFixture(path, child, uid));
  assert.equal(executions, 0, "unsafe fixtures must be rejected before the Docker executor");
}

describe("traffic maintenance fixture preflight", () => {
  it("accepts a private current-owned directory and contained shared child", async () => {
    assert.equal(await inspectFixture(), realpathSync(shared));
    assert.equal(executions, 1);
  });

  it("accepts a system temporary-directory alias without accepting a symlink fixture root", async () => {
    const alias = join(workspace, "system-tmp-alias");
    symlinkSync(realpathSync(tmpdir()), alias, "dir");
    const aliasedRoot = join(alias, basename(workspace), "fixture");
    // A symlink in the root's parent (like macOS /tmp) is permitted.
    assert.equal(
      await inspectFixture(aliasedRoot, join(aliasedRoot, "valhalla", "osm-pbf")),
      realpathSync(shared),
    );
  });

  it("rejects a 0755 root before Docker without repairing it", async () => {
    chmodSync(root, 0o755);
    await rejectsBeforeDocker();
    assert.equal(lstatSync(root).mode & 0o7777, 0o755);
  });

  it("rejects a symlink root before Docker", async () => {
    const alias = join(workspace, "root-alias");
    symlinkSync(root, alias, "dir");
    await rejectsBeforeDocker(alias, join(alias, "valhalla", "osm-pbf"));
  });

  it("rejects a symlink root with a trailing directory separator before Docker", async () => {
    const alias = join(workspace, "root-alias");
    symlinkSync(root, alias, "dir");
    await rejectsBeforeDocker(`${alias}/`, join(alias, "valhalla", "osm-pbf"));
  });

  it("rejects a regular file root before Docker", async () => {
    const file = join(workspace, "file");
    writeFileSync(file, "not a directory");
    await rejectsBeforeDocker(file, shared);
  });

  it("rejects a missing root before Docker without creating it", async () => {
    await rejectsBeforeDocker(join(workspace, "missing"), shared);
  });

  it("rejects a shared child symlink escaping the root before Docker", async () => {
    const outside = join(workspace, "fixture-sibling");
    mkdirSync(outside);
    rmSync(shared, { recursive: true });
    symlinkSync(outside, shared, "dir");
    await rejectsBeforeDocker();
  });

  it("rejects a child equal to the root before Docker", async () => {
    await rejectsBeforeDocker(root, root);
  });

  it("rejects a foreign owner before Docker", { skip: !process.geteuid }, async () => {
    // Model a different effective UID without changing ownership on the host.
    await rejectsBeforeDocker(root, shared, lstatSync(root).uid + 1);
  });

  it("fails closed when effective UID cannot be established", async () => {
    await assert.rejects(
      withPrivateFixture(
        root,
        shared,
        async () => {
          executions++;
        },
        undefined,
      ),
    );
    assert.equal(executions, 0);
  });
});
