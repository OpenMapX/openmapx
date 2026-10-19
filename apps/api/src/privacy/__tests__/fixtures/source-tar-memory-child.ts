import { createHash } from "node:crypto";
import { SOURCE_TAR_LIMITS, SourceTarReader } from "../../source-tar-reader.js";
import { checksumTarHeader, tarMember } from "./source-tar.js";

const targetBytes = 192 * 1024 * 1024 + 17;
const chunk = Buffer.alloc(64 * 1024, "x");
const header = tarMember("large.bin", Buffer.alloc(0));
header.write(`${targetBytes.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
checksumTarHeader(header);
let peakRss = 0;
let peakExternal = 0;
function sampleMemory(): void {
  const memory = process.memoryUsage();
  peakRss = Math.max(peakRss, memory.rss);
  peakExternal = Math.max(peakExternal, memory.external);
}
sampleMemory();
const input = (async function* () {
  yield header;
  for (let remaining = targetBytes; remaining > 0; remaining -= chunk.length) {
    sampleMemory();
    yield chunk.subarray(0, Math.min(chunk.length, remaining));
  }
  yield Buffer.alloc(((512 - (targetBytes % 512)) % 512) + 1024);
})();
const reader = new SourceTarReader(input, SOURCE_TAR_LIMITS, (code) => new Error(code));
const hash = createHash("sha256");
let bytes = 0;
let members = 0;
await reader.read(async (member) => {
  members += 1;
  for await (const data of member.content) {
    bytes += data.length;
    hash.update(data);
    sampleMemory();
  }
});
sampleMemory();
process.stdout.write(
  JSON.stringify({ bytes, sha256: hash.digest("hex"), members, peakRss, peakExternal }),
);
