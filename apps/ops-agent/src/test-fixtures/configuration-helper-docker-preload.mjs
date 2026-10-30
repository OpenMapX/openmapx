/** Replace only the external Docker executable. Inherited PATH and all source
 * values stay identical to the actual signed old-agent snapshot. */
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const spawn = childProcess.spawn,
  fixture = fileURLToPath(new URL("./configuration-helper-docker.mjs", import.meta.url));
childProcess.spawn = (file, args, options) => {
  const child =
    file === "docker"
      ? spawn(process.execPath, [fixture, ...args], options)
      : spawn(file, args, options);
  if (file === "docker" && process.env.OPENMAPX_TEST_HELPER_PROCESS_FILE && child.pid)
    fs.appendFileSync(process.env.OPENMAPX_TEST_HELPER_PROCESS_FILE, `${child.pid}\n`, {
      mode: 0o600,
    });
  return child;
};
const fault = process.env.OPENMAPX_TEST_HELPER_FAULT;
if (fault === "before-effect" || fault === "after-effect") {
  const rename = fs.renameSync,
    root = process.env.OPENMAPX_ROOT_DIR,
    key = JSON.parse(process.env.OPENMAPX_CONTROL_EXECUTION).operationKey;
  let injected = false;
  fs.renameSync = (from, to) => {
    let match = false;
    if (!injected && basename(String(to)) === `${key}.json`) {
      const actual = fs.statSync(dirname(String(to))),
        expected = fs.statSync(join(root, "infra/docker/control-private/ops-agent/effects"));
      match =
        actual.dev === expected.dev &&
        actual.ino === expected.ino &&
        JSON.parse(fs.readFileSync(from, "utf8"))?.payload?.receipt?.kind ===
          "configuration-helper-completion";
    }
    if (!match) return rename(from, to);
    injected = true;
    if (fault === "after-effect") rename(from, to);
    fs.writeFileSync(join(root, "native-helper-fault-observed"), fault, { mode: 0o600 });
    throw Error("Named helper effect publication interruption");
  };
}
syncBuiltinESMExports();
