/** Existing public producer entry. Optional-context calls become retained
 * immediate jobs; owned handlers call the same strict private implementation. */
import {
  type ApplyTrustedConfigurationOptions,
  applyTrustedConfigurationWithEvidence as applyOwned,
  completeTrustedConfigurationApplication,
} from "./trusted-configuration-producer";

export * from "./trusted-configuration-producer";
export async function applyTrustedConfigurationWithEvidence(
  options: ApplyTrustedConfigurationOptions,
): ReturnType<typeof applyOwned> {
  if (options.ctx) return applyOwned(options);
  return (await import("./job-runner")).jobRunner.applyImmediateConfiguration(options);
}
export async function applyTrustedConfiguration(options: ApplyTrustedConfigurationOptions) {
  return completeTrustedConfigurationApplication(
    options,
    await applyTrustedConfigurationWithEvidence(options),
  );
}
