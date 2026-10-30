/** Closed participant dispatch; writer ownership does not depend on handlers. */
import {
  type AdministrativeConfigurationWriter,
  administrativeConfigurationState,
  type ConfigurationCommitParticipant,
} from "./administrative-configuration-writer-owner";

const rejected = () => new Error("Configuration writer unavailable");

export async function withConfigurationCommitParticipant<T>(
  writer: AdministrativeConfigurationWriter,
  participant: ConfigurationCommitParticipant,
  run: () => Promise<T>,
): Promise<T> {
  const state = administrativeConfigurationState(writer);
  const { isLegacyIntegrationImportParticipant } = await import(
    "./configuration-migration/legacy-integration-import-intent"
  );
  const { isIntegrationBindingParticipant } = await import("./integration-binding-participant");
  const { isTransitCredentialParticipant } = await import("./transit-feed-credential-participant");
  const { isPlatformConfigurationParticipant } = await import(
    "./platform-configuration-participant"
  );
  // Exact installed built-in issuer, never a registration or caller callback.
  if (
    (!isLegacyIntegrationImportParticipant(participant, writer) &&
      !isIntegrationBindingParticipant(participant, writer) &&
      !isTransitCredentialParticipant(participant, writer) &&
      !isPlatformConfigurationParticipant(participant, writer)) ||
    participant.actorId !== writer.actorId ||
    participant.operationKey !== writer.operationKey ||
    (state.participant && state.participant !== participant)
  )
    throw rejected();
  if (state.participant) return run();
  state.participant = participant;
  try {
    await participant.authorize(writer);
    return await run();
  } finally {
    state.participant = undefined;
  }
}
