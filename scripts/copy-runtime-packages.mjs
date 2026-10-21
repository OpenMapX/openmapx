import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Copies the installed package directories a runtime bundle lists in its
 * `runtime-packages.json` from one root's node_modules into another's, with
 * the node_modules links that resolve to them, so Node resolves every kept
 * package as in the full install. Links to packages left behind are not
 * recreated. Node built-ins only: the image's production stage runs this
 * without the workspace's development dependencies.
 */
export function copyRuntimePackages(directories, from, to) {
  const source = realpathSync(from);
  const kept = new Set(directories.map((directory) => join(source, directory)));
  const missing = directories.filter((directory) => !existsSync(join(source, directory)));
  if (missing.length > 0) {
    throw new Error(`The install has no ${missing.join(", ")}`);
  }
  const ancestors = new Set();
  for (const directory of kept) {
    for (let path = dirname(directory); path.startsWith(source + sep); path = dirname(path)) {
      ancestors.add(path);
    }
  }
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const target = join(to, relative(source, path));
      if (entry.isSymbolicLink()) {
        let real;
        try {
          real = realpathSync(path);
        } catch {
          continue;
        }
        if (!kept.has(real)) continue;
        mkdirSync(dirname(target), { recursive: true });
        symlinkSync(readlinkSync(path), target);
      } else if (entry.isDirectory()) {
        if (kept.has(path)) cpSync(path, target, { recursive: true, verbatimSymlinks: true });
        // Links to kept packages live in node_modules and the scope directories
        // inside them, including pnpm's hoisted node_modules/.pnpm/node_modules.
        // pnpm's store directories for scoped packages (`.pnpm/@scope+name@1`)
        // are not scopes: only those of kept packages are entered, as ancestors.
        else if (
          ancestors.has(path) ||
          entry.name === "node_modules" ||
          (entry.name[0] === "@" && basename(directory) === "node_modules")
        ) {
          visit(path);
        }
      }
    }
  };
  const modules = join(source, "node_modules");
  if (existsSync(modules)) visit(modules);
}

// Usage: node scripts/copy-runtime-packages.mjs <runtime-packages.json> <from root> <to root>
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [list, from, to] = process.argv.slice(2);
  try {
    copyRuntimePackages(JSON.parse(readFileSync(list, "utf8")), from, to);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
