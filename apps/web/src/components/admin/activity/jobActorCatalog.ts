/**
 * The fixed actor labels the activity API sends for jobs, one per data job
 * trigger and for an application job no known user started.
 * `scripts/admin-code-catalogue.test.ts` keeps this list in step with
 * `apps/api/src/services/activity-jobs.ts`.
 */
export const JOB_ACTOR_LABELS: readonly string[] = [
  "Administrator",
  "API",
  "Bootstrap",
  "Host CLI",
  "Operations agent",
  "Scheduled",
  "System",
];

/** The `adminActivity.actorLabel` select key for an actor label. */
export function jobActorKey(label: string): string {
  return label.toLowerCase().replace(/\s+/g, "_");
}
