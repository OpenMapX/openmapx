import { createHash } from "node:crypto";
import { encodeJsonLines } from "../../primary-source-stream.js";

const targetBytes = 192 * 1024 * 1024;
const payload = "x".repeat(1024 - 32);
let produced = 0;
let peakRss = process.memoryUsage().rss;
let peakExternal = process.memoryUsage().external;
const encoded = encodeJsonLines(
  (async function* () {
    for (let id = 0; produced < targetBytes; id += 1) {
      const record = { id: id.toString().padStart(12, "0"), payload };
      produced += Buffer.byteLength(JSON.stringify(record)) + 1;
      if (id % 4096 === 0) {
        const memory = process.memoryUsage();
        peakRss = Math.max(peakRss, memory.rss);
        peakExternal = Math.max(peakExternal, memory.external);
      }
      yield record;
    }
  })(),
);
const hash = createHash("sha256");
for await (const chunk of encoded.source) hash.update(chunk);
const facts = await encoded.facts;
process.stdout.write(
  JSON.stringify({
    ...facts,
    observedSha256: hash.digest("hex"),
    peakRss,
    peakExternal,
    finalRss: process.memoryUsage().rss,
  }),
);
