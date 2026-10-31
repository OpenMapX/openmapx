/** Read-only requirements from an already isolated, pin-verified checkout.
 * Pin resolution and checkout ownership belong to the caller. */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { isWellFormedFeedCredentialText } from "./feed-credentials";

const unavailable = () => new Error("Catalog credential requirements are unavailable");
const decoder = new TextDecoder("utf-8", { fatal: true });
export interface FeedCredentialRequirementScope {
  countries: readonly string[];
  patches: readonly { sourceId: string; skip: boolean }[];
}
export function collectRequiredFeedCredentialKeys(
  catalogDir: string,
  scope?: FeedCredentialRequirementScope,
): string[] {
  let bytes = 0,
    files = 0;
  const directory = (path: string) => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
  };
  const json = (path: string): Record<string, unknown> => {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = fstatSync(fd);
      files += 1;
      bytes += before.size;
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size > 4 * 1024 * 1024 ||
        files > 50000 ||
        bytes > 128 * 1024 * 1024
      )
        throw unavailable();
      const raw = readFileSync(fd),
        after = fstatSync(fd),
        current = lstatSync(path);
      if (
        raw.length !== before.size ||
        before.ino !== current.ino ||
        before.dev !== current.dev ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw unavailable();
      const value: unknown = JSON.parse(decoder.decode(raw));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
      return value as Record<string, unknown>;
    } catch {
      throw unavailable();
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  const atlas = join(catalogDir, "transitland-atlas", "feeds"),
    feedDir = join(catalogDir, "feeds"),
    authorized = new Set<string>(),
    required = new Set<string>();
  try {
    directory(catalogDir);
    directory(join(catalogDir, "transitland-atlas"));
    directory(atlas);
    directory(feedDir);
    const pending = [atlas];
    let dirs = 0;
    while (pending.length) {
      const path = pending.pop();
      if (!path) throw unavailable();
      if (++dirs > 10000) throw unavailable();
      directory(path);
      const entries = readdirSync(path, { withFileTypes: true });
      if (entries.length > 50000) throw unavailable();
      for (const entry of entries) {
        if (entry.isSymbolicLink()) throw unavailable();
        const file = join(path, entry.name);
        if (entry.isDirectory()) pending.push(file);
        else if (entry.isFile() && entry.name.endsWith(".dmfr.json")) {
          const value = json(file);
          if (value.feeds !== undefined && !Array.isArray(value.feeds)) throw unavailable();
          for (const feed of (value.feeds ?? []) as Record<string, unknown>[]) {
            if (!feed || typeof feed !== "object") throw unavailable();
            if (
              typeof feed.id === "string" &&
              feed.id.length &&
              feed.authorization !== undefined &&
              feed.authorization !== null
            )
              authorized.add(feed.id);
          }
        }
      }
    }
    const feeds = readdirSync(feedDir, { withFileTypes: true });
    if (feeds.length > 50000) throw unavailable();
    for (const entry of feeds) {
      if (entry.isSymbolicLink()) throw unavailable();
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const value = json(join(feedDir, entry.name));
      if (value.sources !== undefined && !Array.isArray(value.sources)) throw unavailable();
      for (const source of (value.sources ?? []) as Record<string, unknown>[]) {
        if (!source || typeof source !== "object") throw unavailable();
        const id = source["transitland-atlas-id"];
        if (typeof id !== "string" || !authorized.has(id)) continue;
        if (typeof source["api-key"] === "string" && source["api-key"].trim()) continue;
        if (typeof source["url-override"] === "string" && source["url-override"].trim()) continue;
        if (
          typeof source.name !== "string" ||
          !source.name.trim() ||
          !isWellFormedFeedCredentialText(source.name)
        )
          throw unavailable();
        if (scope) {
          const region = entry.name.slice(0, -5),
            country = region.split("-")[0]!.toLowerCase();
          if (scope.countries.length && !scope.countries.includes(country)) continue;
          const sourceId =
            typeof source["openmapx-source-id"] === "string"
              ? source["openmapx-source-id"]
              : `catalog:${region}:${source.name}`;
          const patch = scope.patches.find((patch) => patch.sourceId === sourceId);
          if (patch?.skip ?? source.skip === true) continue;
        }
        required.add(`${entry.name.slice(0, -5)}/${source.name}`);
      }
    }
    return [...required].sort();
  } catch {
    throw unavailable();
  }
}
