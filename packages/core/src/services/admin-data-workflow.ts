/** Business progress, never execution authority. Uses original indexed private
 * records so retention/capacity/recovery remain owned by the control family. */
import { z } from "zod";
import {
  controlDigest,
  executionAuthorityState,
  readPrivateRecord,
  signControl,
  type VerifiedExecutionAuthority,
  verifyControl,
  withPrivateEffectWriter,
  writePrivateRecord,
} from "../build-artifacts/control-authority";
import { AnchoredDirectory, identity, sameInode } from "../build-artifacts/filesystem";
import { verifyFamilyOwnedRecord } from "../build-artifacts/retention-family";
import { canonicalJson } from "../ops/canonical-json";
import { type DataWorkflowReceipt, dataWorkflowReceiptSchema } from "../ops/job-evidence";

const domain = "openmapx-admin-data-workflow-v1";
const bodySchema = z.strictObject({
  version: z.literal(1),
  operationKey: z.string(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  receipt: dataWorkflowReceiptSchema,
});
const phases = ["osm", "transit", "fonts", "build", "link", "complete"] as const;
export async function openAdminDataWorkflow(options: {
  dataRoot: string;
  operationKey: string;
  fingerprint: string;
  authority: VerifiedExecutionAuthority;
}): Promise<{
  read(): DataWorkflowReceipt | null;
  checkpoint(receipt: DataWorkflowReceipt): Promise<void>;
}> {
  const state = executionAuthorityState(options.authority);
  if (
    state.kind !== "data.update" ||
    !state.origin ||
    state.execution.operationKey !== options.operationKey ||
    state.execution.fingerprint !== options.fingerprint
  )
    throw Error("Original Full Update owner required");
  const root = new AnchoredDirectory(options.dataRoot),
    trusted = new AnchoredDirectory(state.installation.dataRoot);
  try {
    if (!sameInode(identity(root.stat), identity(trusted.stat)))
      throw Error("Foreign workflow data root");
  } finally {
    root.close();
    trusted.close();
  }
  const name = `data-workflow-${state.execution.operationKey}.json`;
  const read = () => {
    let raw: unknown;
    try {
      raw = readPrivateRecord(state.installation, "observations", name, 65536);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    verifyFamilyOwnedRecord(
      state.installation,
      state.origin!,
      { scope: "private", namespace: "observations", container: "", name },
      canonicalJson(raw),
    );
    const body = verifyControl(state.installation.installation.publicKey, domain, raw, bodySchema);
    if (
      body.operationKey !== state.execution.operationKey ||
      body.fingerprint !== state.execution.fingerprint
    )
      throw Error("Workflow owner changed");
    return body.receipt;
  };
  return {
    read,
    async checkpoint(value) {
      const receipt = dataWorkflowReceiptSchema.parse(value);
      withPrivateEffectWriter(state, () => {
        const prior = read();
        if (prior) {
          if (
            phases.indexOf(receipt.phase) < phases.indexOf(prior.phase) ||
            prior.children.some(
              (child, index) => controlDigest(child) !== controlDigest(receipt.children[index]),
            ) ||
            prior.completedBuildIds.some((id) => !receipt.completedBuildIds.includes(id)) ||
            prior.failedBuildIds.some((id) => !receipt.failedBuildIds.includes(id))
          )
            throw Error("Workflow progress cannot be replaced or rewound");
          if (canonicalJson(prior) === canonicalJson(receipt)) return;
        }
        if (
          receipt.phase === "complete" &&
          (receipt.children.length !== 3 ||
            receipt.children.some((child) => child.status !== "succeeded") ||
            receipt.failedBuildIds.length ||
            receipt.skippedBuildIds.length ||
            !receipt.revisionId)
        )
          throw Error("Incomplete Full Update cannot be reported complete");
        const signed = signControl(state.installation.privateKey, domain, {
          version: 1 as const,
          operationKey: state.execution.operationKey,
          fingerprint: state.execution.fingerprint,
          receipt,
        });
        if (Buffer.byteLength(canonicalJson(signed)) > 65536)
          throw Error("Workflow checkpoint exceeds retention capacity");
        writePrivateRecord(state.installation, "observations", name, signed, !prior, state.origin);
      });
    },
  };
}
