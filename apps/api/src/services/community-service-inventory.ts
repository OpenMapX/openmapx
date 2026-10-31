/** Read-only community inventory; service discovery never imports mutation orchestration. */
import { randomUUID } from "node:crypto";
import type { OpsResultFor } from "@openmapx/core/ops";
import { services as coreServices } from "@openmapx/core/server";
import { createApiOpsClient, createDurableOpsKey, executeAndWait } from "./ops-client";
export interface CommunityServicesSnapshot {
  revisionId: string;
  repositories: OpsResultFor<"communityServices.inspect">["repositories"];
  services: Array<{
    repository: string;
    directory: string;
    manifest: coreServices.ServiceManifest;
  }>;
  /** Reported services the API's own manifest rules reject. */
  problems: string[];
  /** Ids of every service the agent reported, including rejected ones. */
  reportedServiceIds: string[];
}

/** Installed community services and repositories, validated again with the community manifest rules. */
export async function readCommunityServices(
  options: { signal?: AbortSignal } = {},
): Promise<CommunityServicesSnapshot> {
  const result = await executeAndWait(
    createApiOpsClient(),
    { kind: "communityServices.inspect" },
    createDurableOpsKey("community.services.inspect", randomUUID()),
    { signal: options.signal },
  );
  const problems: string[] = [];
  const services: CommunityServicesSnapshot["services"] = [];
  for (const entry of result.services) {
    const manifestProblems = coreServices.communityServiceManifestProblems(entry.manifest);
    if (manifestProblems.length > 0) {
      problems.push(
        `Community service in repository ${entry.repository} was rejected: ${manifestProblems.join("; ")}`,
      );
      continue;
    }
    services.push({
      repository: entry.repository,
      directory: entry.directory,
      manifest: entry.manifest as unknown as coreServices.ServiceManifest,
    });
  }
  return {
    revisionId: result.revisionId,
    repositories: result.repositories,
    services,
    problems,
    reportedServiceIds: result.services.flatMap((entry) =>
      typeof entry.manifest.id === "string" ? [entry.manifest.id] : [],
    ),
  };
}
