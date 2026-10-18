import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { readPackageCandidate } from "../package-release-io.mjs";

// Fixed executable fixture: all varying input is JSON, never generated code.
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const receipt = join(input.directory, "receipt.json");
const original = join(input.directory, "receipt-original");
const replacement = join(input.directory, "replacement");
const real = Object.fromEntries(
  ["openSync", "closeSync", "fstatSync", "lstatSync", "readSync", "readFileSync"].map((key) => [
    key,
    fs[key],
  ]),
);
const descriptors = new Set();
const result = {
  error: null,
  opened: 0,
  closed: 0,
  bytesRead: 0,
  maxReadRequest: 0,
  unboundedRead: false,
  replacementRead: false,
};
let mutated = false;
let movedOriginal = false;
let receiptStats = 0;
function mutate() {
  if (mutated || !["replacement", "growth", "small-growth"].includes(input.mode)) return;
  mutated = true;
  if (["growth", "small-growth"].includes(input.mode))
    fs.appendFileSync(receipt, " ".repeat(input.mode === "growth" ? 256 * 1024 : 16));
  else {
    fs.renameSync(receipt, original);
    movedOriginal = true;
    fs.writeFileSync(replacement, "REPLACEMENT_TARGET_MUST_NOT_BE_READ");
    fs.symlinkSync(replacement, receipt);
  }
}
fs.openSync = (path, ...args) => {
  const fd = real.openSync(path, ...args);
  if (path === receipt) {
    descriptors.add(fd);
    result.opened++;
  }
  return fd;
};
fs.closeSync = (fd) => {
  if (descriptors.delete(fd)) result.closed++;
  return real.closeSync(fd);
};
fs.lstatSync = (path, ...args) => {
  const stat = real.lstatSync(path, ...args);
  if (path === receipt) {
    receiptStats++;
    if (!["growth", "small-growth"].includes(input.mode) || receiptStats === 2) mutate();
  }
  return stat;
};
fs.fstatSync = (fd, ...args) => {
  const stat = real.fstatSync(fd, ...args);
  if (descriptors.has(fd)) mutate();
  return stat;
};
fs.readSync = (fd, buffer, offset, length, position) => {
  const count = real.readSync(fd, buffer, offset, length, position);
  if (descriptors.has(fd)) {
    result.bytesRead += count;
    result.maxReadRequest = Math.max(result.maxReadRequest, length);
    if (buffer.subarray(offset, offset + count).includes("REPLACEMENT_TARGET"))
      result.replacementRead = true;
  }
  return count;
};
fs.readFileSync = (path, ...args) => {
  const body = real.readFileSync(path, ...args);
  if (path === receipt || descriptors.has(path)) {
    result.unboundedRead = true;
    if (body.includes("REPLACEMENT_TARGET")) result.replacementRead = true;
  }
  return body;
};
try {
  if (input.mode === "fifo") {
    fs.renameSync(receipt, original);
    movedOriginal = true;
    execFileSync("mkfifo", [receipt]);
  }
  syncBuiltinESMExports();
  readPackageCandidate({
    directory: input.directory,
    expectedHash: input.expectedHash,
    context: input.context,
    ...(input.members
      ? {
          run(executable, args) {
            if (executable === "tar" && args[0] === "-tzf") return input.members.join("\n");
            return execFileSync(executable, args, { encoding: "utf8" }).trim();
          },
        }
      : {}),
  });
} catch (error) {
  result.error = error.message;
} finally {
  Object.assign(fs, real);
  syncBuiltinESMExports();
  if (movedOriginal) {
    fs.rmSync(receipt);
    fs.renameSync(original, receipt);
  }
  fs.rmSync(replacement, { force: true });
}
process.stdout.write(JSON.stringify(result));
