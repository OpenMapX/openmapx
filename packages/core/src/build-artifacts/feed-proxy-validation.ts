/** Closed ops-agent producer proof for completed nginx read-validation only. */
import { z } from "zod";
import { type OpsJobStatus, parseOpsJobStatus } from "../ops/contract";
import { controlTerminalReceiptDigest } from "../ops/control-retention-receipt";
import type { ExecutionRef } from "../ops/execution-ref";
import { executionRefSchema } from "../ops/execution-ref";
import { canonicalJson, opsOperationFingerprint } from "../ops/fingerprint";
// biome-ignore-start lint/suspicious/noImportCycles: This fixed producer shares the existing nominal authority/effect writer; it is invoked only after module initialization.
import {
  assertControlExecutionForward,
  controlDigest,
  executionAuthorityState,
  readPrivateRecord,
  type VerifiedExecutionAuthority,
  withPrivateEffectWriter,
  writePrivateRecord,
} from "./control-authority";
// biome-ignore-end lint/suspicious/noImportCycles: Fixed live producer dependency described above.
import {
  controlOriginSchema,
  sameControlOrigin,
  signControl,
  verifyControl,
} from "./control-records";
// biome-ignore lint/suspicious/noImportCycles: The finite producer rechecks the same retained candidate at invocation, after schemas initialize.
import { verifyDataTransitCandidateForExecution } from "./data-execution-candidate";
import { AnchoredDirectory } from "./filesystem";
import { familyRecordWrite, verifyFamilyOwnedRecord } from "./retention-family";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const schema = z
  .strictObject({
    version: z.literal(2),
    installationId: z.uuid(),
    origin: controlOriginSchema,
    execution: executionRefSchema,
    admissionDigest: digest,
    candidateId: z.string().max(64),
    candidateDigest: digest,
    reservedAt: z.number().int().nonnegative().safe(),
    phase: z.enum(["validation_pending", "validation_failed", "reload_started"]),
    completedAt: z.number().int().nonnegative().safe().nullable(),
    validationExitCode: z.number().int().min(1).max(255).nullable(),
    completionDigest: digest.nullable(),
    padding: z.string().max(4096),
  })
  .superRefine((p, ctx) => {
    if (
      (p.phase === "validation_failed") !==
        (p.validationExitCode !== null && p.completionDigest !== null) ||
      (p.phase === "validation_pending") !== (p.completedAt === null)
    )
      ctx.addIssue({ code: "custom", message: "Invalid fixed validation phase" });
  });
type Proof = z.infer<typeof schema>;
const domain = "openmapx-feed-proxy-validation-v2";
const name = (authority: VerifiedExecutionAuthority) =>
  `proxy-validation-${authority.execution.operationKey}.json`;
function state(authority: VerifiedExecutionAuthority) {
  const s = executionAuthorityState(authority);
  if (
    s.installation.installation.role !== "ops-agent" ||
    s.kind !== "feedProxy.validateAndReload" ||
    !s.origin
  )
    throw Error("Original fixed proxy authority required");
  return s;
}
function read(authority: VerifiedExecutionAuthority) {
  const s = state(authority),
    raw = readPrivateRecord(s.installation, "observations", name(authority), 4096);
  const p = verifyControl(s.installation.installation.publicKey, domain, raw, schema);
  if (
    p.installationId !== s.installation.installation.installationId ||
    !sameControlOrigin(p.origin, s.origin) ||
    p.admissionDigest !== s.receiptDigest ||
    controlDigest(p.execution) !== controlDigest(s.execution) ||
    opsOperationFingerprint({ kind: "feedProxy.validateAndReload", candidateId: p.candidateId }) !==
      s.execution.operationFingerprint
  )
    throw Error("Original validation proof identity changed");
  verifyFamilyOwnedRecord(
    s.installation,
    p.origin,
    { scope: "private", namespace: "observations", container: "", name: name(authority) },
    canonicalJson(raw),
  );
  return p;
}
function write(authority: VerifiedExecutionAuthority, value: Proof, exclusive = false) {
  const s = state(authority),
    p = { ...value, padding: "" };
  // Account the entire cell up front; transitions allocate no additional space.
  const signed = signControl(s.installation.privateKey, domain, p);
  const room = 4096 - Buffer.byteLength(canonicalJson(signed));
  if (room < 0) throw Error("Validation proof capacity exceeded");
  p.padding = " ".repeat(room);
  const parsed = schema.parse(p);
  writePrivateRecord(
    s.installation,
    "observations",
    name(authority),
    signControl(s.installation.privateKey, domain, parsed),
    exclusive,
    s.origin,
  );
}
export function feedProxyValidationCompletionDigest(
  execution: ExecutionRef,
  candidateDigest: string,
  nonce: string,
  validationExitCode: number,
): string {
  return controlDigest({
    domain: "openmapx-feed-proxy-validation-completion-v1",
    execution,
    candidateDigest,
    nonce,
    validationExitCode,
  });
}
export function reserveFeedProxyValidation(
  authority: VerifiedExecutionAuthority,
  candidateId: string,
  candidateDigest: string,
): void {
  const s = state(authority);
  assertControlExecutionForward(authority);
  verifyDataTransitCandidateForExecution(
    authority,
    { kind: "feedProxy.validateAndReload", candidateId },
    candidateDigest,
  );
  withPrivateEffectWriter(s, () => {
    let raw: unknown;
    try {
      raw = readPrivateRecord(s.installation, "observations", name(authority), 4096);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (raw !== null && raw !== undefined) {
      const prior = read(authority);
      if (prior.candidateId !== candidateId || prior.candidateDigest !== candidateDigest)
        throw Error("Validation candidate changed");
      const dir = witnessDirectory(s.installation);
      try {
        dir.role.read(`${s.execution.operationKey}.proxy-terminal.json`, 4096);
      } finally {
        dir.close();
      }
      return;
    }
    write(
      authority,
      schema.parse({
        version: 2,
        installationId: s.installation.installation.installationId,
        origin: s.origin,
        execution: s.execution,
        admissionDigest: s.receiptDigest,
        candidateId,
        candidateDigest,
        reservedAt: Date.now(),
        phase: "validation_pending",
        completedAt: null,
        validationExitCode: null,
        completionDigest: null,
        padding: "",
      }),
      true,
    );
    reserveWitness(authority);
  });
}
export function commitFeedProxyValidationFailure(
  authority: VerifiedExecutionAuthority,
  input: { candidateDigest: string; validationExitCode: number; completionDigest: string },
): void {
  const s = state(authority);
  withPrivateEffectWriter(s, () => {
    const p = read(authority);
    if (p.candidateDigest !== input.candidateDigest) throw Error("Foreign validation candidate");
    if (p.phase === "validation_failed") {
      if (
        p.validationExitCode !== input.validationExitCode ||
        p.completionDigest !== input.completionDigest
      )
        throw Error("Validation commitment changed");
      return;
    }
    if (p.phase !== "validation_pending") throw Error("Reload already attempted");
    // A new producer commitment verifies the actual invocation's bytes. An
    // identical existing commitment above observes its frozen original proof,
    // which remains valid after a later legitimate restore replaces files.
    verifyDataTransitCandidateForExecution(
      authority,
      { kind: "feedProxy.validateAndReload", candidateId: p.candidateId },
      p.candidateDigest,
    );
    write(
      authority,
      schema.parse({ ...p, ...input, phase: "validation_failed", completedAt: Date.now() }),
    );
  });
}
export function recordFeedProxyReloadAttempted(authority: VerifiedExecutionAuthority): void {
  const s = state(authority);
  withPrivateEffectWriter(s, () => {
    const p = read(authority);
    if (p.phase !== "validation_pending") throw Error("Validation phase already consumed");
    verifyDataTransitCandidateForExecution(
      authority,
      { kind: "feedProxy.validateAndReload", candidateId: p.candidateId },
      p.candidateDigest,
    );
    write(authority, { ...p, phase: "reload_started", completedAt: Date.now() });
  });
}
/** Frozen original proof stays valid after a legitimate restore replaces files. */
export function inspectFeedProxyValidationFailure(
  authority: VerifiedExecutionAuthority,
  expectedDigest?: string,
): string | null {
  const p = read(authority);
  if (p.phase !== "validation_failed") return null;
  const proofDigest = controlDigest(p);
  if (expectedDigest !== undefined && expectedDigest !== proofDigest)
    throw Error("Foreign validation commitment");
  return proofDigest;
}

const terminalSchema = z.strictObject({
  version: z.literal(2),
  installationId: z.uuid(),
  origin: controlOriginSchema,
  execution: executionRefSchema,
  admissionDigest: digest,
  phase: z.enum(["pending", "canonical"]),
  status: z.unknown().nullable(),
  terminalAt: z.number().int().positive().safe().nullable(),
  terminalDigest: digest.nullable(),
  padding: z.string().max(4096),
});
function witnessDirectory(local: ReturnType<typeof executionAuthorityState>["installation"]) {
  const data = new AnchoredDirectory(local.dataRoot),
    control = data.directory(".admin-target-control"),
    executions = control.directory("executions"),
    role = executions.directory("ops-agent");
  return {
    role,
    close() {
      role.close();
      executions.close();
      control.close();
      data.close();
    },
  };
}
function writeWitness(
  authority: VerifiedExecutionAuthority,
  payload: z.infer<typeof terminalSchema>,
  exclusive: boolean,
) {
  const s = state(authority),
    dir = witnessDirectory(s.installation),
    name = `${s.execution.operationKey}.proxy-terminal.json`;
  try {
    const value = { ...payload, padding: "" },
      domain = "openmapx-proxy-canonical-terminal-v2";
    const room =
      4096 -
      Buffer.byteLength(canonicalJson(signControl(s.installation.privateKey, domain, value)));
    if (room < 0) throw Error("Proxy terminal cell capacity exceeded");
    value.padding = " ".repeat(room);
    const bytes = canonicalJson(signControl(s.installation.privateKey, domain, value));
    familyRecordWrite(
      s.installation,
      payload.origin,
      { scope: "shared", namespace: "execution", container: "ops-agent", name },
      bytes,
      (before) => dir.role.write(name, bytes, exclusive, before),
      exclusive,
    );
  } finally {
    dir.close();
  }
}
function reserveWitness(authority: VerifiedExecutionAuthority) {
  const s = state(authority);
  writeWitness(
    authority,
    terminalSchema.parse({
      version: 2,
      installationId: s.installation.installation.installationId,
      origin: s.origin,
      execution: s.execution,
      admissionDigest: s.receiptDigest,
      phase: "pending",
      status: null,
      terminalAt: null,
      terminalDigest: null,
      padding: "",
    }),
    true,
  );
}
/** Only an already sealed original complete canonical tuple can publish this
 * finite shared proxy witness. It creates no new terminal time or status. */
export function publishFeedProxyCanonicalTerminal(
  authority: VerifiedExecutionAuthority,
  input: OpsJobStatus,
  terminalAt: number,
) {
  const s = state(authority),
    status = parseOpsJobStatus(input),
    terminalDigest = controlTerminalReceiptDigest(status);
  const original = verifyControl(
    s.installation.installation.publicKey,
    "openmapx-control-terminal-v1",
    readPrivateRecord(
      s.installation,
      "observations",
      `terminal-${s.execution.operationKey}.json`,
      8192,
    ),
    z
      .object({
        phase: z.literal("canonical"),
        execution: executionRefSchema,
        admissionDigest: digest,
        terminalAt: z.number(),
        terminalDigest: digest,
      })
      .passthrough(),
  );
  if (
    controlDigest(original.execution) !== controlDigest(s.execution) ||
    original.admissionDigest !== s.receiptDigest ||
    original.terminalAt !== terminalAt ||
    original.terminalDigest !== terminalDigest
  )
    throw Error("Original canonical proxy terminal required");
  const dir = witnessDirectory(s.installation);
  try {
    const prior = verifyControl(
      s.installation.installation.publicKey,
      "openmapx-proxy-canonical-terminal-v2",
      JSON.parse(
        dir.role.read(`${s.execution.operationKey}.proxy-terminal.json`, 4096).toString("utf8"),
      ),
      terminalSchema,
    );
    if (
      prior.installationId !== s.installation.installation.installationId ||
      prior.admissionDigest !== s.receiptDigest ||
      !sameControlOrigin(prior.origin, s.origin) ||
      controlDigest(prior.execution) !== controlDigest(s.execution)
    )
      throw Error("Original reserved proxy terminal changed");
    if (prior.phase === "canonical") {
      if (prior.terminalDigest !== terminalDigest || prior.terminalAt !== terminalAt)
        throw Error("Proxy canonical terminal changed");
      return;
    }
    // Diagnostics are observational and deliberately excluded from the exact
    // canonical digest. Keep the fixed shared tuple bounded.
    writeWitness(
      authority,
      {
        ...prior,
        phase: "canonical",
        status: { ...status, diagnostics: { tail: [], truncated: false } },
        terminalDigest,
        terminalAt,
      },
      false,
    );
  } finally {
    dir.close();
  }
}
export function verifyFeedProxyCanonicalTerminal(
  parent: VerifiedExecutionAuthority,
  execution: ExecutionRef,
): OpsJobStatus {
  const s = executionAuthorityState(parent),
    dir = witnessDirectory(s.installation);
  try {
    const proof = verifyControl(
      s.installation.publicKeys["ops-agent"],
      "openmapx-proxy-canonical-terminal-v2",
      JSON.parse(
        dir.role.read(`${execution.operationKey}.proxy-terminal.json`, 4096).toString("utf8"),
      ),
      terminalSchema,
    );
    if (
      proof.phase !== "canonical" ||
      proof.installationId !== s.installation.installation.installationId ||
      !sameControlOrigin(proof.origin, s.origin) ||
      controlDigest(proof.execution) !== controlDigest(execution) ||
      !proof.terminalAt
    )
      throw Error("Original canonical proxy child missing");
    const status = parseOpsJobStatus(proof.status);
    if (
      status.kind !== "feedProxy.validateAndReload" ||
      status.operationId !== execution.executionId ||
      status.operationKey !== execution.operationKey ||
      status.fingerprint !== execution.fingerprint ||
      status.deadlineAt !== execution.deadlineAt ||
      controlTerminalReceiptDigest(status) !== proof.terminalDigest
    )
      throw Error("Canonical proxy status changed");
    return status;
  } finally {
    dir.close();
  }
}
