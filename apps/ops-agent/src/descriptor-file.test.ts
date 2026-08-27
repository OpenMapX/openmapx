import {
  fstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DescriptorReadOptions,
  listDescriptorAnchoredDirectory,
  readDescriptorAnchoredUtf8 as readProductionDescriptorAnchoredUtf8,
} from "./descriptor-file";

const roots: string[] = [];

function fixture(contents = "trusted"): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), "openmapx-descriptor-file-"));
  roots.push(root);
  mkdirSync(join(root, "one", "two"), { recursive: true, mode: 0o700 });
  const file = join(root, "one", "two", "value.json");
  writeFileSync(file, contents, { mode: 0o600 });
  return { root, file };
}

function listTestDirectory(root: string, components: readonly string[], maximumEntries: number) {
  if (process.platform === "linux") {
    return listDescriptorAnchoredDirectory(root, components, { maximumEntries });
  }
  const anchor = mkdtempSync(join(root, ".test-list-anchor-"));
  const targets = [
    root,
    ...components.map((_component, index) => join(root, ...components.slice(0, index + 1))),
  ];
  let opened = 0;
  return listDescriptorAnchoredDirectory(root, components, {
    maximumEntries,
    descriptorAnchorRoot: anchor,
    hooks: {
      descriptorOpened: (descriptor) => {
        symlinkSync(targets[opened] as string, join(anchor, String(descriptor)));
        opened += 1;
      },
    },
  });
}

function readDescriptorAnchoredUtf8(
  root: string,
  components: readonly string[],
  options: DescriptorReadOptions,
): string {
  if (process.platform === "linux" || options.descriptorAnchorRoot) {
    return readProductionDescriptorAnchoredUtf8(root, components, options);
  }
  const anchor = mkdtempSync(join(root, ".test-fd-anchor-"));
  const targets = [
    root,
    ...components
      .slice(0, -1)
      .map((_component, index) => join(root, ...components.slice(0, index + 1))),
    join(root, ...components),
  ];
  let opened = 0;
  const original = options.hooks?.descriptorOpened;
  return readProductionDescriptorAnchoredUtf8(root, components, {
    ...options,
    descriptorAnchorRoot: anchor,
    hooks: {
      ...options.hooks,
      descriptorOpened: (descriptor) => {
        symlinkSync(targets[opened] as string, join(anchor, String(descriptor)));
        opened += 1;
        original?.(descriptor);
      },
    },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("descriptor-anchored bounded reads", () => {
  it("enumerates exact bounded directory entries through the same descriptor chain", () => {
    const { root } = fixture();
    writeFileSync(join(root, "one", "two", "second.json"), "second", { mode: 0o600 });
    expect(listTestDirectory(root, ["one", "two"], 2)).toEqual([
      { name: "second.json", type: "file" },
      { name: "value.json", type: "file" },
    ]);
    expect(() => listTestDirectory(root, ["one", "two"], 1)).toThrow(
      "Trusted directory listing rejected",
    );
  });

  it("reads an exact stable regular file through opened directory descriptors", () => {
    const { root } = fixture();
    expect(
      readDescriptorAnchoredUtf8(root, ["one", "two", "value.json"], { maximumBytes: 16 }),
    ).toBe("trusted");
  });

  it.each(["ancestor", "final"] as const)("rejects a %s symlink", (kind) => {
    const { root, file } = fixture();
    const outside = join(root, "outside");
    writeFileSync(outside, "outside", { mode: 0o600 });
    if (kind === "final") {
      rmSync(file);
      symlinkSync(outside, file);
    } else {
      rmSync(join(root, "one"), { recursive: true });
      symlinkSync(root, join(root, "one"));
    }
    expect(() =>
      readDescriptorAnchoredUtf8(root, ["one", "two", "value.json"], { maximumBytes: 16 }),
    ).toThrow("Trusted file read rejected");
  });

  it("rejects hardlinks, special files, oversize files, and in-place growth", () => {
    const hardlink = fixture();
    linkSync(hardlink.file, join(hardlink.root, "copy"));
    expect(() =>
      readDescriptorAnchoredUtf8(hardlink.root, ["one", "two", "value.json"], {
        maximumBytes: 16,
      }),
    ).toThrow();

    const special = fixture();
    rmSync(special.file);
    symlinkSync("/dev/null", special.file);
    expect(() =>
      readDescriptorAnchoredUtf8(special.root, ["one", "two", "value.json"], {
        maximumBytes: 16,
      }),
    ).toThrow();

    const oversized = fixture("x".repeat(17));
    expect(() =>
      readDescriptorAnchoredUtf8(oversized.root, ["one", "two", "value.json"], {
        maximumBytes: 16,
      }),
    ).toThrow();

    const growing = fixture();
    expect(() =>
      readDescriptorAnchoredUtf8(growing.root, ["one", "two", "value.json"], {
        maximumBytes: 16,
        hooks: { afterFileOpen: () => writeFileSync(growing.file, "trusted-growth") },
      }),
    ).toThrow();
  });

  it("detects deterministic ancestor, final-name, and root inode replacements", () => {
    const ancestor = fixture();
    expect(() =>
      readDescriptorAnchoredUtf8(ancestor.root, ["one", "two", "value.json"], {
        maximumBytes: 16,
        hooks: {
          afterDirectoryOpen: ({ index }) => {
            if (index !== 0) return;
            renameSync(join(ancestor.root, "one"), join(ancestor.root, "old-one"));
            mkdirSync(join(ancestor.root, "one", "two"), { recursive: true, mode: 0o700 });
            writeFileSync(join(ancestor.root, "one", "two", "value.json"), "replacement", {
              mode: 0o600,
            });
          },
        },
      }),
    ).toThrow();

    const final = fixture();
    expect(() =>
      readDescriptorAnchoredUtf8(final.root, ["one", "two", "value.json"], {
        maximumBytes: 16,
        hooks: {
          afterFileOpen: () => {
            renameSync(final.file, `${final.file}.old`);
            writeFileSync(final.file, "replacement", { mode: 0o600 });
          },
        },
      }),
    ).toThrow();

    const rootSwap = fixture();
    expect(() =>
      readDescriptorAnchoredUtf8(rootSwap.root, ["one", "two", "value.json"], {
        maximumBytes: 16,
        hooks: {
          afterRootOpen: () => {
            renameSync(rootSwap.root, `${rootSwap.root}-old`);
            mkdirSync(rootSwap.root, { mode: 0o700 });
          },
        },
      }),
    ).toThrow();
    roots.push(`${rootSwap.root}-old`);
  });

  it("fails closed without the descriptor anchor and closes every opened descriptor", () => {
    const { root } = fixture();
    expect(() =>
      readDescriptorAnchoredUtf8(root, ["one", "two", "value.json"], {
        maximumBytes: 16,
        descriptorAnchorRoot: join(root, "missing-anchor"),
      }),
    ).toThrow("Trusted file read rejected");

    const seen: number[] = [];
    expect(() =>
      readDescriptorAnchoredUtf8(root, ["one", "two", "value.json"], {
        maximumBytes: 16,
        hooks: {
          descriptorOpened: (descriptor) => seen.push(descriptor),
          afterFileOpen: () => {
            throw new Error("injected failure");
          },
        },
      }),
    ).toThrow("Trusted file read rejected");
    expect(seen.length).toBeGreaterThan(0);
    for (const descriptor of seen) expect(() => fstatSync(descriptor)).toThrow();
  });

  it("rejects truncation and same-size overwrite after the file is opened", () => {
    const truncated = fixture("trusted");
    expect(() =>
      readDescriptorAnchoredUtf8(truncated.root, ["one", "two", "value.json"], {
        maximumBytes: 16,
        hooks: { afterFileOpen: () => truncateSync(truncated.file, 2) },
      }),
    ).toThrow();

    const overwritten = fixture("trusted");
    expect(() =>
      readDescriptorAnchoredUtf8(overwritten.root, ["one", "two", "value.json"], {
        maximumBytes: 16,
        hooks: { afterRead: () => writeFileSync(overwritten.file, "altered", { mode: 0o600 }) },
      }),
    ).toThrow();
  });
});
