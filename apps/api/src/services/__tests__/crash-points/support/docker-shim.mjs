// The `docker` executable the crash-point suite puts first on PATH. It forwards
// each invocation to the suite's fake Docker engine over loopback HTTP and
// replays the engine's answer as stdout, stderr and exit status. An answer can
// be held back by the engine, which is how a test parks an effect "in flight".
import { request } from "node:http";

const engine = process.env.OPENMAPX_CRASH_DOCKER_ENGINE;
if (!engine) {
  process.stderr.write("docker: the crash-point engine address is not set\n");
  process.exit(125);
}

const stdinCommands = new Set(["load", "login"]);
const args = process.argv.slice(2);

async function readStdin() {
  if (!stdinCommands.has(args[0]) && !(args[0] === "exec" && args.includes("-i"))) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("base64");
}

const body = JSON.stringify({
  args,
  cwd: process.cwd(),
  pid: process.pid,
  caller: process.env.OPENMAPX_CRASH_ROLE ?? "unknown",
  // `docker run --env NAME` copies NAME from the client's own environment, so a
  // run carries all of it; other commands only what Compose interpolation reads.
  env: Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        args.includes("run") ||
        key.startsWith("COMPOSE_") ||
        key.startsWith("OPENMAPX_") ||
        key === "DOCKER_CONFIG" ||
        key === "HOME" ||
        key === "UID" ||
        key === "GID",
    ),
  ),
  stdin: await readStdin(),
});

const url = new URL("invoke", engine);
const req = request(
  url,
  { method: "POST", headers: { "content-type": "application/json" }, timeout: 0 },
  (res) => {
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => {
      let answer;
      try {
        answer = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        process.stderr.write("docker: the crash-point engine sent no answer\n");
        process.exit(125);
      }
      if (answer.stdout) process.stdout.write(answer.stdout);
      if (answer.stderr) process.stderr.write(answer.stderr);
      process.exitCode = answer.code;
    });
  },
);
req.on("error", () => {
  process.stderr.write("Cannot connect to the Docker daemon\n");
  process.exit(1);
});
req.end(body);
