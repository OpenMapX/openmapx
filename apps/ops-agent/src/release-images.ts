import { services as coreServices } from "@openmapx/core/server";

export interface DockerCommandContext {
  signal: AbortSignal;
  emitLog(stream: "stdout" | "stderr", message: string): void;
}

export type DockerCommandRunner = (
  args: readonly string[],
  context: DockerCommandContext,
) => Promise<string>;

export interface AgentReleasePins {
  agentImage: string;
  helperImage: string;
}

/** Image observations shared by the agent and its replacement helper. */
export function createImageInspection(runDocker: DockerCommandRunner) {
  const inspectImageId = async (
    args: readonly string[],
    context: DockerCommandContext,
  ): Promise<string | undefined> => {
    try {
      const value = (await runDocker(args, context)).trim();
      return /^sha256:[a-f0-9]{64}$/.test(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };
  // A container created from a digest-pinned reference keeps that digest in
  // its image's RepoDigests, so a release pin can be compared with the running
  // image before the pinned image has been downloaded.
  const inspectRepoDigests = async (
    imageId: string,
    context: DockerCommandContext,
  ): Promise<string[] | undefined> => {
    try {
      const value = JSON.parse(
        (
          await runDocker(
            ["image", "inspect", "--format", "{{json .RepoDigests}}", imageId],
            context,
          )
        ).trim(),
      ) as unknown;
      return Array.isArray(value) && value.every((entry) => typeof entry === "string")
        ? value
        : undefined;
    } catch {
      return undefined;
    }
  };
  // `matches` stays undefined when neither observation succeeded, so callers
  // can fail closed instead of treating an unreadable image as different.
  const observePinnedImage = async (
    runningImageId: string,
    pinnedImage: string,
    context: DockerCommandContext,
  ): Promise<{ matches?: boolean; localImageId?: string }> => {
    const localImageId = await inspectImageId(
      ["image", "inspect", "--format", "{{.Id}}", pinnedImage],
      context,
    );
    if (localImageId === runningImageId) return { matches: true, localImageId };
    const pinnedDigest = /@(sha256:[a-f0-9]{64})$/.exec(pinnedImage)?.[1];
    const repoDigests = await inspectRepoDigests(runningImageId, context);
    if (pinnedDigest && repoDigests?.some((entry) => entry.endsWith(`@${pinnedDigest}`))) {
      return { matches: true, ...(localImageId ? { localImageId } : {}) };
    }
    if (repoDigests === undefined && localImageId === undefined) return {};
    return { matches: false, ...(localImageId ? { localImageId } : {}) };
  };
  // Inspect only the non-secret helper reference, never the complete environment.
  const inspectAgentHelper = async (
    containerId: string,
    context: DockerCommandContext,
  ): Promise<string | undefined> => {
    const key = coreServices.PRIVACY_BACKUP_COLLECTOR_IMAGE_ENV;
    try {
      const value = (
        await runDocker(
          [
            "container",
            "inspect",
            "--format",
            `{{range .Config.Env}}{{if eq (index (split . "=") 0) "${key}"}}{{println .}}{{end}}{{end}}`,
            containerId,
          ],
          context,
        )
      ).trim();
      return value.startsWith(`${key}=`) && !value.includes("\n")
        ? value.slice(key.length + 1)
        : undefined;
    } catch {
      return undefined;
    }
  };
  /** False for any unreadable observation: an unknown agent is never current. */
  const agentMatchesRelease = async (
    containerId: string,
    pins: AgentReleasePins,
    context: DockerCommandContext,
  ): Promise<boolean> => {
    const running = await inspectImageId(
      ["container", "inspect", "--format", "{{.Image}}", containerId],
      context,
    );
    return (
      running !== undefined &&
      (await observePinnedImage(running, pins.agentImage, context)).matches === true &&
      (await inspectAgentHelper(containerId, context)) === pins.helperImage
    );
  };
  return {
    inspectImageId,
    inspectRepoDigests,
    observePinnedImage,
    inspectAgentHelper,
    agentMatchesRelease,
  };
}
