import {
  ArtifactStageTransportError,
  type OpsClient,
  OpsClientError,
  type OpsOperation,
  type OpsOperationKind,
  type OpsResultFor,
  type TransferStage,
} from "@openmapx/core/ops";
import { createApiOpsClient, createDurableOpsKey } from "./ops-client";
export class AdminArtifactTransferError extends Error {
  constructor(readonly statusCode: number) {
    super("Artifact transfer unavailable; inspect the retained stage before retrying");
  }
}
export class AdminArtifactTransfers {
  constructor(private readonly client: OpsClient = createApiOpsClient()) {}
  private async execute<K extends OpsOperationKind>(
    operation: Extract<OpsOperation, { kind: K }>,
  ): Promise<OpsResultFor<K>> {
    try {
      const result = await this.client.execute(operation);
      if (!("execution" in result) || result.execution !== "sync") throw Error();
      return result.value;
    } catch (error) {
      if (error instanceof OpsClientError)
        throw new AdminArtifactTransferError(
          error.status && [404, 409, 410, 413, 415, 422, 429, 503, 507].includes(error.status)
            ? error.status
            : 503,
        );
      throw error;
    }
  }
  async validate(ownerId: string, stageId: string, key: string) {
    const stage = await this.inspect(ownerId, stageId);
    if (
      stage.purpose !== "prepared-artifact" ||
      stage.direction !== "upload" ||
      !["uploaded", "ready", "validating"].includes(stage.state)
    )
      throw new AdminArtifactTransferError(409);
    const { jobRunner } = await import("./job-runner"),
      { MaintenanceRequestConflict } = await import("./retained-maintenance-job");
    try {
      const jobId = await jobRunner.enqueueMaintenance(
        "artifact.validate",
        { stageId, ownerId },
        ownerId,
        key,
      );
      return { ok: true as const, jobId };
    } catch (error) {
      if (error instanceof MaintenanceRequestConflict) throw new AdminArtifactTransferError(409);
      throw error;
    }
  }
  list(ownerId: string, limit = 50, offset = 0) {
    return this.execute({ kind: "artifactTransfer.list", ownerId, limit, offset });
  }
  async inspect(ownerId: string, stageId: string): Promise<TransferStage> {
    const list = await this.list(ownerId, 100, 0);
    const found = list.items.find((s) => s.stageId === stageId);
    if (!found) throw new AdminArtifactTransferError(404);
    return this.execute({
      kind: "artifactTransfer.inspect",
      stageId,
      ownerId,
      purpose: found.purpose,
    });
  }
  create(
    ownerId: string,
    key: string,
    input: {
      purpose: "prepared-artifact" | "instance-migration" | "integration-artifact";
      direction: "upload";
      declaredBytes: number;
      expectedSha256?: string;
    },
  ) {
    return this.execute({
      kind: "artifactTransfer.create",
      ...input,
      ownerId,
      operationKey: createDurableOpsKey("artifact-transfer.create", `${ownerId}:${key}`),
    });
  }
  async delete(ownerId: string, stageId: string) {
    return this.execute({ kind: "artifactTransfer.delete", stageId, ownerId });
  }
  async upload(
    ownerId: string,
    stageId: string,
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    contentLength?: number,
  ) {
    const stage = await this.inspect(ownerId, stageId);
    try {
      return await this.client.uploadArtifactStage({
        stageId,
        ownerId,
        purpose: stage.purpose,
        body,
        contentLength,
        signal,
        executionDeadlineAt: new Date(
          Math.min(Date.parse(stage.expiresAt), Date.now() + 72 * 3600_000),
        ).toISOString(),
      });
    } catch (error) {
      if (error instanceof ArtifactStageTransportError)
        throw new AdminArtifactTransferError(error.status);
      throw error;
    }
  }
  async download<T>(
    ownerId: string,
    stageId: string,
    signal: AbortSignal,
    consume: (input: {
      body: ReadableStream<Uint8Array>;
      signal: AbortSignal;
      headers: Headers;
    }) => Promise<T>,
  ): Promise<T> {
    const stage = await this.inspect(ownerId, stageId);
    try {
      return await this.client.consumeArtifactStage(
        {
          stageId,
          ownerId,
          purpose: stage.purpose,
          signal,
          executionDeadlineAt: new Date(
            Math.min(Date.parse(stage.expiresAt), Date.now() + 72 * 3600_000),
          ).toISOString(),
        },
        consume,
      );
    } catch (error) {
      if (error instanceof ArtifactStageTransportError)
        throw new AdminArtifactTransferError(error.status);
      throw error;
    }
  }
}
