import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atomicWrite, durableUnlink, fsyncDirectory } from "../release-files";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    closeSync: vi.fn(actual.closeSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    renameSync: vi.fn(actual.renameSync),
    unlinkSync: vi.fn(actual.unlinkSync),
  };
});
const real = await vi.importActual<typeof import("node:fs")>("node:fs");
const handles = new Set<number>();
let root: string;
let path: string;
const failure = () => Object.assign(new Error("injected filesystem failure"), { code: "EIO" });

beforeEach(() => {
  vi.mocked(fs.openSync)
    .mockReset()
    .mockImplementation((file, flags, mode) => {
      const fd = real.openSync(file, flags, mode);
      handles.add(fd);
      return fd;
    });
  vi.mocked(fs.closeSync)
    .mockReset()
    .mockImplementation((fd) => {
      real.closeSync(fd);
      handles.delete(fd);
    });
  vi.mocked(fs.writeFileSync).mockReset().mockImplementation(real.writeFileSync);
  vi.mocked(fs.fsyncSync).mockReset().mockImplementation(real.fsyncSync);
  vi.mocked(fs.renameSync).mockReset().mockImplementation(real.renameSync);
  vi.mocked(fs.unlinkSync).mockReset().mockImplementation(real.unlinkSync);
  root = real.mkdtempSync(join(tmpdir(), "openmapx-release-files-"));
  path = join(root, "state.json");
});
afterEach(() => {
  try {
    expect([...handles], "every owned descriptor is closed").toEqual([]);
  } finally {
    for (const fd of handles) real.closeSync(fd);
    handles.clear();
    vi.clearAllMocks();
    real.rmSync(root, { recursive: true, force: true });
  }
});
const entries = () => real.readdirSync(root).sort();

// These faults retain real disk operations on either side of the injected syscall.
// Assertions pin published bytes, private modes, cleanup and descriptor ownership.
describe("release atomic replacement", () => {
  it.each(["", "new state 🗺️"])("creates a private complete file containing %j", (value) => {
    atomicWrite(path, value);
    expect(real.readFileSync(path, "utf8")).toBe(value);
    expect(real.statSync(path).mode & 0o777).toBe(0o600);
    expect(entries()).toEqual(["state.json"]);
  });

  it("replaces the destination inode without modifying other hard links", () => {
    real.writeFileSync(path, "old state", { mode: 0o644 });
    const other = join(root, "other.json");
    real.linkSync(path, other);
    atomicWrite(path, "new state");
    expect(real.readFileSync(other, "utf8")).toBe("old state");
    expect(real.readFileSync(path, "utf8")).toBe("new state");
    expect(real.statSync(path).nlink).toBe(1);
    expect(real.statSync(path).mode & 0o777).toBe(0o600);
    expect(entries()).toEqual(["other.json", "state.json"]);
  });

  it("replaces a destination symlink without writing its target", () => {
    const target = join(root, "target.json");
    real.writeFileSync(target, "untouched");
    real.symlinkSync(target, path);
    atomicWrite(path, "new state");
    expect(real.lstatSync(path).isSymbolicLink()).toBe(false);
    expect(real.readFileSync(path, "utf8")).toBe("new state");
    expect(real.readFileSync(target, "utf8")).toBe("untouched");
  });

  it("syncs and closes the private temporary before publication, then syncs its directory", () => {
    real.writeFileSync(path, "old state");
    const events: string[] = [];
    vi.mocked(fs.writeFileSync).mockImplementation((file, data, options) => {
      expect(typeof file).toBe("number");
      expect(real.fstatSync(file as number).mode & 0o777).toBe(0o600);
      expect(real.readFileSync(path, "utf8")).toBe("old state");
      events.push("write");
      real.writeFileSync(file, data, options);
    });
    vi.mocked(fs.fsyncSync).mockImplementation((fd) => {
      const directory = real.fstatSync(fd).isDirectory();
      expect(real.readFileSync(path, "utf8")).toBe(directory ? "new state" : "old state");
      events.push(directory ? "directory sync" : "file sync");
      real.fsyncSync(fd);
    });
    vi.mocked(fs.closeSync).mockImplementation((fd) => {
      events.push(real.fstatSync(fd).isDirectory() ? "directory close" : "file close");
      real.closeSync(fd);
      handles.delete(fd);
    });
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      expect(handles.size).toBe(0);
      expect(real.readFileSync(from, "utf8")).toBe("new state");
      expect(to).toBe(path);
      events.push("rename");
      real.renameSync(from, to);
    });
    atomicWrite(path, "new state");
    expect(events).toEqual([
      "write",
      "file sync",
      "file close",
      "rename",
      "directory sync",
      "directory close",
    ]);
  });

  it.each(["file", "symlink"])(
    "never removes a foreign %s on exclusive temporary collision",
    (kind) => {
      real.writeFileSync(path, "old state");
      let collision = "";
      vi.mocked(fs.openSync).mockImplementationOnce((file, flags, mode) => {
        collision = String(file);
        expect(flags).toBe(
          fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_WRONLY |
            fs.constants.O_NOFOLLOW |
            fs.constants.O_NONBLOCK,
        );
        expect(mode).toBe(0o600);
        if (kind === "file") real.writeFileSync(file, "foreign");
        else real.symlinkSync(path, file);
        return real.openSync(file, flags, mode);
      });
      expect(() => atomicWrite(path, "new state")).toThrow();
      expect(real.readFileSync(path, "utf8")).toBe("old state");
      expect(real.lstatSync(collision).isSymbolicLink()).toBe(kind === "symlink");
      if (kind === "file") expect(real.readFileSync(collision, "utf8")).toBe("foreign");
    },
  );

  it.each(["write", "file sync", "close", "rename"])(
    "cleans its temporary and retains old bytes after %s failure",
    (stage) => {
      real.writeFileSync(path, "old state");
      const error = failure();
      if (stage === "write")
        vi.mocked(fs.writeFileSync).mockImplementationOnce((file) => {
          real.writeFileSync(file, "partial");
          throw error;
        });
      if (stage === "file sync")
        vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
          throw error;
        });
      if (stage === "close")
        vi.mocked(fs.closeSync).mockImplementationOnce((fd) => {
          real.closeSync(fd);
          handles.delete(fd);
          throw error;
        });
      if (stage === "rename")
        vi.mocked(fs.renameSync).mockImplementationOnce(() => {
          throw error;
        });
      expect(() => atomicWrite(path, "new state")).toThrow(error);
      expect(real.readFileSync(path, "utf8")).toBe("old state");
      expect(entries()).toEqual(["state.json"]);
    },
  );

  it.each(["directory open", "directory sync"])(
    "reports %s failure after publication without pretending to restore the old state",
    (stage) => {
      real.writeFileSync(path, "old state");
      const error = failure();
      if (stage === "directory open") {
        vi.mocked(fs.openSync).mockImplementation((file, flags, mode) => {
          if (String(file) === root) throw error;
          const fd = real.openSync(file, flags, mode);
          handles.add(fd);
          return fd;
        });
      } else {
        vi.mocked(fs.fsyncSync).mockImplementation((fd) => {
          if (real.fstatSync(fd).isDirectory()) throw error;
          real.fsyncSync(fd);
        });
      }
      expect(() => atomicWrite(path, "new state")).toThrow(error);
      expect(real.readFileSync(path, "utf8")).toBe("new state");
      expect(entries()).toEqual(["state.json"]);
    },
  );

  it("preserves the write error when close and temporary cleanup also fail", () => {
    real.writeFileSync(path, "old state");
    const error = failure();
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
      throw error;
    });
    vi.mocked(fs.closeSync).mockImplementationOnce((fd) => {
      real.closeSync(fd);
      handles.delete(fd);
      throw new Error("close failure");
    });
    vi.mocked(fs.unlinkSync).mockImplementationOnce(() => {
      throw new Error("cleanup failure");
    });
    expect(() => atomicWrite(path, "new state")).toThrow(error);
    expect(real.readFileSync(path, "utf8")).toBe("old state");
    expect(entries()).toHaveLength(2); // Cleanup really failed; no false removal claim.
  });

  it("does not conceal a cleanup failure after failed publication", () => {
    const renameError = failure();
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw renameError;
    });
    vi.mocked(fs.unlinkSync).mockImplementationOnce(() => {
      throw new Error("cleanup failure");
    });
    expect(() => atomicWrite(path, "new state")).toThrow(renameError);
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatch(/^state\.json\.tmp-/);
  });
});

describe("release directory syncing", () => {
  it("opens only a directory without following its final symlink", () => {
    fsyncDirectory(root);
    expect(fs.openSync).toHaveBeenCalledWith(
      root,
      fs.constants.O_RDONLY |
        fs.constants.O_DIRECTORY |
        fs.constants.O_NOFOLLOW |
        fs.constants.O_NONBLOCK,
    );
    const link = join(root, "link");
    real.symlinkSync(root, link);
    expect(() => fsyncDirectory(link)).toThrow();
    real.writeFileSync(path, "file");
    expect(() => fsyncDirectory(path)).toThrow();
  });

  it("preserves directory sync failure if closing its descriptor also fails", () => {
    const error = failure();
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
      throw error;
    });
    vi.mocked(fs.closeSync).mockImplementationOnce((fd) => {
      real.closeSync(fd);
      handles.delete(fd);
      throw new Error("close failure");
    });
    expect(() => fsyncDirectory(root)).toThrow(error);
  });

  it("reports directory close failures without retrying a released descriptor", () => {
    const error = failure();
    vi.mocked(fs.closeSync).mockImplementationOnce((fd) => {
      real.closeSync(fd);
      handles.delete(fd);
      throw error;
    });
    expect(() => fsyncDirectory(root)).toThrow(error);
    expect(fs.closeSync).toHaveBeenCalledTimes(1);
  });

  it("closes the directory descriptor after a sync failure", () => {
    const error = failure();
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
      throw error;
    });
    expect(() => fsyncDirectory(root)).toThrow(error);
  });
});

describe("durable release deletion", () => {
  it("removes the entry and syncs the containing directory", () => {
    real.writeFileSync(path, "state");
    vi.mocked(fs.fsyncSync).mockImplementation((fd) => {
      expect(real.existsSync(path)).toBe(false);
      expect(real.fstatSync(fd).isDirectory()).toBe(true);
      real.fsyncSync(fd);
    });
    durableUnlink(path);
    expect(entries()).toEqual([]);
  });

  it("allows an already missing entry without syncing a missing parent", () => {
    durableUnlink(join(root, "absent", "state.json"));
    expect(entries()).toEqual([]);
  });

  it("unlinks a symlink without deleting its target", () => {
    real.writeFileSync(path, "state");
    const link = join(root, "link");
    real.symlinkSync(path, link);
    durableUnlink(link);
    expect(real.readFileSync(path, "utf8")).toBe("state");
    expect(entries()).toEqual(["state.json"]);
  });

  it("propagates an unlink failure without removing the entry", () => {
    real.writeFileSync(path, "state");
    const error = failure();
    vi.mocked(fs.unlinkSync).mockImplementationOnce(() => {
      throw error;
    });
    expect(() => durableUnlink(path)).toThrow(error);
    expect(real.readFileSync(path, "utf8")).toBe("state");
  });

  it.each(["ENOENT", "EIO"])(
    "reports parent sync failure %s even after the entry is removed",
    (code) => {
      real.writeFileSync(path, "state");
      const error = Object.assign(failure(), { code });
      vi.mocked(fs.openSync).mockImplementationOnce(() => {
        throw error;
      });
      expect(() => durableUnlink(path)).toThrow(error);
      expect(entries()).toEqual([]);
    },
  );
});
