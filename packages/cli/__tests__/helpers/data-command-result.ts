import {
  type DataExecutionInput,
  dataExecutionStatusSchema,
} from "@openmapx/core/data-manager-contracts";

/** Presentation collaborator only; this value is never a signed execution proof. */
export function unitDataCommandResult(kind: DataExecutionInput["kind"]) {
  return dataExecutionStatusSchema.parse({
    id: "00000000-0000-4000-8000-000000000001",
    operationKey: "opk1_unit_command_policy",
    fingerprint: "a".repeat(64),
    admittedAt: 1,
    deadlineAt: 4102444800000,
    kind,
    status: "ok",
    publication: "committed",
    cancellationRequestedAt: null,
    progress: 1,
    diagnostics: { tail: [], truncated: false },
  });
}
