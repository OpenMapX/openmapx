#!/usr/bin/env node
/** Named external Docker I/O only for the owned native helper fixture. */
async function main() {
  const url = new URL(process.env.OPENMAPX_TEST_DOCKER_BRIDGE);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
    throw Error("Invalid fixture bridge");
  const response = await fetch(new URL("/docker", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ args: process.argv.slice(2) }),
  });
  if (!response.ok) throw Error("Named Docker IO failed");
  const result = await response.json();
  if (typeof result.stdout !== "string" || typeof result.stderr !== "string")
    throw Error("Invalid fixture response");
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}
main().catch(() => {
  process.stderr.write("Named Docker IO failed\n");
  process.exitCode = 1;
});
