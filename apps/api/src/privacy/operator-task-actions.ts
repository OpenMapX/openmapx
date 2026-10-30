import type { SubjectDataRegistration } from "@openmapx/core/privacy";
export type TaskDecisionStatus =
  | "complete"
  | "not_applicable"
  | "operator_review"
  | "retryable"
  | "canceled";
/** Automated acquisition is completed only by its collector; human review cannot invent it. */
export function deriveOperatorTaskActions(
  request: { state: string },
  task: { status: string; registrationId: string },
  registrations: readonly SubjectDataRegistration[],
): { actions: TaskDecisionStatus[]; reason?: string } {
  if (
    ![
      "preserving",
      "collecting",
      "pending_processor",
      "operator_review",
      "clarification_needed",
    ].includes(request.state)
  )
    return { actions: [], reason: "case-not-active" };
  if (task.status === "running") return { actions: [], reason: "collector-active" };
  const registration = registrations.find((r) => r.id === task.registrationId);
  if (!registration) return { actions: [], reason: "registration-unavailable" };
  if (registration.strategy === "operator_task" || task.status === "operator_review")
    return { actions: ["complete", "not_applicable", "operator_review", "retryable", "canceled"] };
  return { actions: ["operator_review", "retryable"], reason: "collector-completion-required" };
}
