// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Uncached CI partition receipts.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export const databaseMatrix = JSON.parse(
  readFileSync(new URL("./database-test-shards.json", import.meta.url)),
);
const timings = JSON.parse(readFileSync(new URL("./database-test-timings.json", import.meta.url)));
const lexical = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const unique = (items) =>
  Array.isArray(items) &&
  items.length > 0 &&
  items.every((item) => typeof item === "string" && item.length > 0) &&
  new Set(items).size === items.length;

/** Longest-first packing affects placement only, never which tests are required. */
export function partitionScenarios(names, total, weights = timings) {
  if (!unique(names) || !Number.isInteger(total) || total < 1 || total > names.length)
    throw new Error("Invalid or duplicate recovery scenario inventory");
  const duration = (name) =>
    weights[name.includes(" > ") ? name.slice(name.indexOf(" > ") + 3) : name] ?? 30;
  const buckets = Array.from({ length: total }, () => ({ seconds: 0, names: [] }));
  for (const name of [...names].sort((a, b) => duration(b) - duration(a) || lexical(a, b))) {
    const bucket = buckets.reduce((best, current) =>
      current.seconds < best.seconds ? current : best,
    );
    bucket.names.push(name);
    bucket.seconds += duration(name);
  }
  return buckets.map((bucket) => bucket.names.sort(lexical));
}

export function scenarioPattern(names) {
  if (!unique(names)) throw new Error("Missing scenario selection");
  // Use the installed Vitest 5 runtime's exact full name, including its suite
  // separator. The filtered runtime collection below verifies this assumption.
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return `^(?:${escaped.join("|")})$`;
}

export function verifyShardReceipts(receipts, matrix, source) {
  if (receipts.length !== matrix.length) throw new Error("Missing database shard receipt");
  for (const { group, part, total } of matrix) {
    const matches = receipts.filter(
      (receipt) => receipt.group === group && receipt.part === part && receipt.total === total,
    );
    if (
      matches.length !== 1 ||
      matches[0].source !== source ||
      !unique(matches[0].all) ||
      !unique(matches[0].selected)
    )
      throw new Error(`Invalid database shard receipt: ${group} ${part}/${total}`);
  }
  for (const group of new Set(matrix.map((entry) => entry.group))) {
    const rows = receipts.filter((receipt) => receipt.group === group);
    const all = [...rows[0].all].sort(lexical);
    if (rows.some((row) => JSON.stringify([...row.all].sort(lexical)) !== JSON.stringify(all)))
      throw new Error(`Database inventory differs between ${group} runners`);
    const selected = rows.flatMap((row) => row.selected).sort(lexical);
    if (JSON.stringify(selected) !== JSON.stringify(all))
      throw new Error(`Lost or duplicated scenarios in ${group}`);
  }
}

export function selectFilePartition({ filters, part, total, collect, cwd = process.cwd() }) {
  const list = (paths) =>
    collect(["list", ...paths, "--project", "node", "--maxWorkers=1", "--filesOnly", "--json"])
      .map((row) => relative(cwd, typeof row === "string" ? row : row.file))
      .sort(lexical);
  const all = list(filters);
  const selected = partitionScenarios(all, total)[part - 1];
  if (!selected || JSON.stringify(list(selected)) !== JSON.stringify(selected))
    throw new Error("Vitest file selection differs from the partition");
  return { all, selected };
}

/** Collect first; verify the actual filtered collection before executing cases. */
export function shardDatabaseCommand({
  group,
  shard,
  command,
  collect,
  cwd = process.cwd(),
  source = process.env.GITHUB_SHA ?? "local",
  receiptPath,
}) {
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(shard ?? "");
  if (!match) throw new Error("Database shard must be <part>/<total>");
  const [part, total] = match.slice(1).map(Number);
  if (
    !databaseMatrix.some(
      (entry) => entry.group === group && entry.part === part && entry.total === total,
    )
  )
    throw new Error(`Unconfigured database shard: ${group} ${shard}`);
  const filters = command.args.slice(command.args.indexOf("--bail=1") + 1);
  const recovery = ["configuration-recovery", "coordinator-recovery"].includes(group);
  const common = ["list", ...filters, "--project", "node", "--maxWorkers=1", "--json"];
  let all, selected, args;
  if (recovery) {
    const rows = collect([...common, "--no-static-parse"]);
    if (!Array.isArray(rows) || rows.some((row) => typeof row.name !== "string"))
      throw new Error("Invalid Vitest scenario inventory");
    all = rows.map((row) => row.name);
    selected = partitionScenarios(all, total)[part - 1];
    const pattern = scenarioPattern(selected);
    // Characterize the actual installed matcher, not a guessed JSON delimiter.
    const filtered = collect([...common, "--no-static-parse", "--testNamePattern", pattern])
      .map((row) => row.name)
      .sort(lexical);
    if (JSON.stringify(filtered) !== JSON.stringify(selected))
      throw new Error("Vitest scenario selection differs from the partition");
    args = [...command.args, "--testNamePattern", pattern];
  } else {
    ({ all, selected } = selectFilePartition({ filters, part, total, collect, cwd }));
    args = [...command.args.slice(0, command.args.indexOf("--bail=1") + 1), ...selected];
  }
  const receipt = {
    group,
    part,
    total,
    source,
    all,
    selected,
    digest: createHash("sha256")
      .update(JSON.stringify([...all].sort(lexical)))
      .digest("hex"),
  };
  if (receiptPath) writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  console.log(
    `${group} ${shard}: ${selected.length}/${all.length} ${recovery ? "scenarios" : "files"}; inventory ${receipt.digest}`,
  );
  return { ...command, args, receipt };
}

if (import.meta.main) {
  try {
    if (!["verify", "verify-linux"].includes(process.argv[2]) || !process.argv[3])
      throw new Error("Usage: database-test-shards.mjs verify <receipt-directory>");
    const directory = process.argv[3];
    const receipts = readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")));
    verifyShardReceipts(
      receipts,
      process.argv[2] === "verify-linux"
        ? [1, 2].map((part) => ({ group: "linux-user", part, total: 2 }))
        : databaseMatrix,
      process.env.GITHUB_SHA,
    );
    console.log(
      "Complete database scenario/file union: every shard present, no loss or duplication.",
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
