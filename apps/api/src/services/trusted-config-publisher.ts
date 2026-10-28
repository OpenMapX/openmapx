/** Stable publisher entry points. Generic queue I/O has one mutex/store;
 * nominal candidate operations defer to the sole actual private owner. */
import type {
  RetainedConfigurationRetirement,
  ValidatedConfigurationCandidate,
} from "./prospective-configuration";

export {
  consumePublishedTrustedConfiguration,
  type PublishTrustedConfigurationSnapshotOptions,
  publishTrustedConfigurationSnapshot,
  readPreparedTrustedConfigurationCandidate,
  retainPreparedTrustedConfigurationCandidate,
  type SnapshotPublishDependencies,
} from "./trusted-config-publication-store";
export async function publishPreparedTrustedConfigurationSnapshot(
  value: ValidatedConfigurationCandidate,
): ReturnType<
  typeof import("./prospective-configuration").publishPreparedTrustedConfigurationSnapshot
> {
  return (await import("./prospective-configuration")).publishPreparedTrustedConfigurationSnapshot(
    value,
  );
}
export async function discardUnadmittedTrustedConfigurationCandidate(
  value: ValidatedConfigurationCandidate,
): ReturnType<
  typeof import("./prospective-configuration").discardUnadmittedTrustedConfigurationCandidate
> {
  return (
    await import("./prospective-configuration")
  ).discardUnadmittedTrustedConfigurationCandidate(value);
}
export async function retireSettledTrustedConfigurationCandidate(
  value: ValidatedConfigurationCandidate,
): ReturnType<
  typeof import("./prospective-configuration").retireSettledTrustedConfigurationCandidate
> {
  return (await import("./prospective-configuration")).retireSettledTrustedConfigurationCandidate(
    value,
  );
}
export async function completeRetainedConfigurationRetirement(
  value: RetainedConfigurationRetirement,
): ReturnType<
  typeof import("./prospective-configuration").completeRetainedConfigurationRetirement
> {
  return (await import("./prospective-configuration")).completeRetainedConfigurationRetirement(
    value,
  );
}
