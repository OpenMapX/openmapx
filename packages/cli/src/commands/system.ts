import type { Command } from "commander";
import { log } from "../lib/output";
import { repoPaths } from "../lib/paths";
import { runSystemUpdate } from "../lib/system-update";

export function registerSystemCommands(program: Command) {
  program
    .command("system")
    .description("Coordinated updates as the real administrator")
    .command("update")
    .description(
      "Review and apply an already checked immutable release through the administrative API",
    )
    .requiredOption("--release-id <id>", "Release ID printed by compose release --check")
    .requiredOption("--digest <sha256>", "Canonical manifest digest printed by the check")
    .requiredOption(
      "--session-file <path>",
      "Operator-provided mode-0600 Better Auth session-cookie file",
    )
    .requiredOption("--receipt <path>", "New private resumable receipt, in a private directory")
    .option("--api-origin <origin>", "HTTPS API origin (default: https://DOMAIN)")
    .option("--no-backup", "Skip the pre-update backup, as in the admin panel")
    .option("--resume", "Resume this receipt's original requests and jobs")
    .option("--allow-loopback-http", "Allow HTTP only to a loopback origin for development")
    .action(async (options) => {
      try {
        const result = await runSystemUpdate({
          infraDir: repoPaths().infraDir,
          apiOrigin: options.apiOrigin,
          sessionFile: options.sessionFile,
          receipt: options.receipt,
          releaseId: options.releaseId,
          manifestDigest: options.digest,
          resume: options.resume,
          createBackup: options.backup,
          allowLoopbackHttp: options.allowLoopbackHttp,
        });
        console.log(`Coordinated update completed: ${result.jobId}`);
        console.log(
          "Verify the running container image digests and service health before declaring deployment complete.",
        );
        console.log("The session file was preserved; remove it when you no longer need it.");
      } catch (error) {
        log.err(
          error instanceof Error
            ? error.message
            : "Coordinated update unavailable; preserve the receipt and inspect Activity",
        );
        process.exitCode = 1;
      }
    });
}
