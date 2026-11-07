import { startTransitousRunner } from "./bootstrap";

const PORT = Number(process.env.TRANSITOUS_RUNNER_PORT ?? 4400);
const CATALOG_DIR = process.env.TRANSITOUS_RUNNER_CATALOG_DIR ?? "/catalog";
const STAGING_DIR = process.env.TRANSITOUS_RUNNER_STAGING_DIR ?? "/staging";
const CAPABILITY_KEY_FILE =
  process.env.TRANSITOUS_RUNNER_CAPABILITY_KEY_FILE ?? "/run/secrets/transitous-runner-capability";

async function main(): Promise<void> {
  await startTransitousRunner(
    {
      catalogDir: CATALOG_DIR,
      stagingDir: STAGING_DIR,
      capabilityKeyFile: CAPABILITY_KEY_FILE,
    },
    { host: "0.0.0.0", port: PORT },
  );
}

void main().catch(() => {
  // The reason is withheld deliberately: startup failures are about the
  // capability key, and its path is the only safe thing to name.
  process.stderr.write("transitous-runner failed to start\n");
  process.exitCode = 1;
});
