/** Bounded source observation only. No authority, writer or grant constructors. */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseEnv } from "node:util";
import { serviceSelectionPath } from "../services/deployment";
import { releaseStatePaths } from "../services/release-state";
export function dataUpdateSourcesDigest(infraDir: string): string {
  const hash = createHash("sha256");
  for (const name of [
    ".env",
    relative(infraDir, serviceSelectionPath(infraDir)),
    relative(infraDir, releaseStatePaths(infraDir).overlay),
  ]) {
    hash.update(name);
    let fd: number | undefined;
    try {
      fd = openSync(join(infraDir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.size > 256 * 1024)
        throw Error("Full Update source unavailable");
      const bytes = readFileSync(fd),
        after = fstatSync(fd);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        before.size !== after.size
      )
        throw Error("Full Update source changed");
      hash.update(bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update("absent");
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  const catalog = join(resolve(infraDir, "../.."), "services");
  try {
    const entries = readdirSync(catalog).sort();
    if (entries.length > 256) throw Error("Full Update catalog exceeds capacity");
    for (const entry of entries) {
      const directory = join(catalog, entry),
        stat = lstatSync(directory);
      if (stat.isSymbolicLink()) throw Error("Full Update catalog source unavailable");
      if (!stat.isDirectory()) continue;
      const path = join(directory, "service.json");
      let fd: number | undefined;
      try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = fstatSync(fd);
        if (!before.isFile() || before.nlink !== 1 || before.size > 128 * 1024)
          throw Error("Full Update catalog source unavailable");
        const bytes = readFileSync(fd),
          after = fstatSync(fd);
        if (
          before.ino !== after.ino ||
          before.ctimeMs !== after.ctimeMs ||
          before.mtimeMs !== after.mtimeMs ||
          before.size !== after.size
        )
          throw Error("Full Update catalog changed");
        hash.update(entry).update(bytes);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return hash.digest("hex");
}

/** Matches the CLI's process.loadEnvFile precedence without mutating this
 * service's environment or retaining unrelated secret values in the plan. */
export function dataUpdateHostDefaults(infraDir: string) {
  let fd: number | undefined;
  try {
    fd = openSync(join(infraDir, ".env"), constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > 256 * 1024)
      throw Error("Full Update host defaults unavailable");
    const bytes = readFileSync(fd),
      after = fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw Error("Full Update host defaults changed");
    const env = parseEnv(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return { domain: env.DOMAIN, region: env.OPENMAPX_REGION, countries: env.TRANSITOUS_COUNTRIES };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {};
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
