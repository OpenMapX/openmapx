import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const producer = fileURLToPath(
  new URL(
    "../../../services/ops-agent/privacy-backup/openmapx-backup-subject-export.py",
    import.meta.url,
  ),
);

// Load the real producer definitions without running its database restore startup.
// Only the metadata sink is substituted for byte-budget cases: allocating a 2 GiB
// archive would obscure the boundary being tested. Interoperability uses tarfile.
const harness = String.raw`
import ast
import contextlib
import io
import json
import sys
import tarfile
import types
from pathlib import Path

tree = ast.parse(Path(sys.argv[1]).read_text())
definitions = []
for node in tree.body:
    if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "REQUEST" for target in node.targets):
        break
    definitions.append(node)
scope = {}
exec(compile(ast.Module(body=definitions, type_ignores=[]), sys.argv[1], "exec"), scope)
scope["REQUEST"] = {"subjectLocator": {"value": "subject-1"}, "cutoff": "2026-10-19T00:00:00Z"}
scenario = json.loads(sys.argv[2])
real_open = tarfile.open
started = False
members = []

class MetadataArchive:
    def __enter__(self):
        return self
    def __exit__(self, *args):
        pass
    def addfile(self, info, source):
        members.append({"path": info.name, "bytes": info.size})

def metadata_open(**kwargs):
    global started
    started = True
    return MetadataArchive()

def entries():
    result = []
    for index in range(scenario.get("count", 1)):
        path = f"openmapx/data-{index}.jsonl"
        if scenario.get("dawarich") and index == 0:
            path = "dawarich/account.json"
        result.append(scope["static_descriptor"](path, b"{}\n"))
    return result

def run(items, padding=0):
    global started, members
    started, members = False, []
    output, errors = io.BytesIO(), io.StringIO()
    schema = {"schemaFingerprint": "a" * 64, "schemaRelations": ["x" * padding]}
    warnings = [] if scenario.get("manifest") == "inner" else ["x" * padding]
    with contextlib.redirect_stdout(types.SimpleNamespace(buffer=output)), contextlib.redirect_stderr(errors):
        try:
            scope["emit"](items, warnings, schema, {"createdAt": "2026-10-18T00:00:00Z"})
            error = None
        except SystemExit as exception:
            error = {"status": exception.code, "message": errors.getvalue().strip()}
    return {"error": error, "started": started, "outputBytes": len(output.getvalue()), "members": members}, output.getvalue()

if scenario.get("real"):
    # A different library default must not change the producer's wire format.
    tarfile.TarFile.format = tarfile.GNU_FORMAT
    result, raw = run(entries())
    with real_open(fileobj=io.BytesIO(raw), mode="r:") as archive:
        actual = archive.getmembers()
        result["paths"] = [member.name for member in actual]
        result["headers"] = [{"magic": raw[member.offset + 257:member.offset + 263].hex(), "version": raw[member.offset + 263:member.offset + 265].decode(), "type": member.type.decode(), "pax": member.pax_headers} for member in actual]
        result["bodies"] = {member.name: archive.extractfile(member).read().decode() for member in actual}
else:
    tarfile.open = metadata_open
    items = entries()
    padding = 0
    if scenario.get("manifest"):
        path = "dawarich/source-manifest.json" if scenario["manifest"] == "inner" else "backup/source-manifest.json"
        baseline, _ = run(entries())
        size = next(member["bytes"] for member in baseline["members"] if member["path"] == path)
        padding = 256 * 1024 + scenario.get("over", 0) - size
    if scenario.get("total"):
        # Eight large declared members, adjusted for the actual final manifests.
        # No source body is read by the metadata sink.
        for item in items:
            item["bytes"] = scope["MAX_ENTRY"]
        items[-1]["bytes"] -= 64 * 1024
        baseline, _ = run([dict(item) for item in items])
        total = sum(member["bytes"] for member in baseline["members"])
        items[-1]["bytes"] += scope["MAX_TOTAL"] + scenario.get("over", 0) - total
    if scenario.get("oversizedMember"):
        items[0]["bytes"] = scope["MAX_ENTRY"] + 1
    result, _ = run(items, padding)
print(json.dumps(result))
`;

type ProducerResult = {
  error: { status: number; message: string } | null;
  started: boolean;
  outputBytes: number;
  members: { path: string; bytes: number }[];
  paths?: string[];
  headers?: { magic: string; version: string; type: string; pax: object }[];
  bodies?: Record<string, string>;
};

function emit(scenario: Record<string, unknown>): ProducerResult {
  const result = spawnSync("python3", ["-c", harness, producer, JSON.stringify(scenario)], {
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as ProducerResult;
}

function expectRejected(result: ProducerResult) {
  expect(result.error).toEqual({ status: 65, message: "limit_exceeded" });
  expect(result.started).toBe(false);
  expect(result.outputBytes).toBe(0);
}

describe("privacy backup archive producer", () => {
  it("writes canonical USTAR regular files that Python tarfile can read, independent of its default", () => {
    const result = emit({ real: true, dawarich: true });
    expect(result.error).toBeNull();
    expect(result.paths).toEqual([
      "dawarich/account.json",
      "dawarich/source-manifest.json",
      "backup/source-manifest.json",
    ]);
    expect(result.headers).toEqual(
      Array(3).fill({ magic: "757374617200", version: "00", type: "0", pax: {} }),
    );
    expect(result.bodies?.["dawarich/account.json"]).toBe("{}\n");
    const outer = JSON.parse(result.bodies?.["backup/source-manifest.json"] ?? "");
    expect(outer.entries.map((entry: { path: string }) => entry.path)).toEqual(
      result.paths?.slice(0, 2),
    );
  });

  it.each([false, true])(
    "counts final manifests toward the 256-member boundary (Dawarich: %s)",
    (dawarich) => {
      const count = dawarich ? 254 : 255;
      const valid = emit({ count, dawarich });
      expect(valid.error).toBeNull();
      expect(valid.members).toHaveLength(256);
      expectRejected(emit({ count: count + 1, dawarich }));
    },
  );

  it.each([false, true])(
    "counts final manifests toward the 2 GiB boundary (Dawarich: %s)",
    (dawarich) => {
      const valid = emit({ count: 8, total: true, dawarich });
      expect(valid.error).toBeNull();
      expect(valid.members.reduce((sum, member) => sum + member.bytes, 0)).toBe(2 * 1024 ** 3);
      expect(valid.members[0]?.bytes).toBe(256 * 1024 ** 2);
      expectRejected(emit({ count: 8, total: true, dawarich, over: 1 }));
    },
  );

  it("rejects a member above 256 MiB before opening the TAR stream", () => {
    expectRejected(emit({ oversizedMember: true }));
  });

  it.each(["inner", "outer"])(
    "bounds the %s manifest at 256 KiB before opening the TAR stream",
    (manifest) => {
      const valid = emit({ manifest, dawarich: manifest === "inner" });
      expect(valid.error).toBeNull();
      expect(
        valid.members.find(
          (member) =>
            member.path === `${manifest === "inner" ? "dawarich" : "backup"}/source-manifest.json`,
        )?.bytes,
      ).toBe(256 * 1024);
      expectRejected(emit({ manifest, dawarich: manifest === "inner", over: 1 }));
    },
  );
});
