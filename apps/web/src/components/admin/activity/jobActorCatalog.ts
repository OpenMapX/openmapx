/**
 * The fixed actor labels the activity API sends for jobs that no known user
 * started. Other labels are derived from the job's trigger and stay as sent.
 * `scripts/admin-code-catalogue.test.ts` keeps this list in step with
 * `apps/api/src/services/activity-jobs.ts`.
 */
export const JOB_ACTOR_LABELS: readonly string[] = [
  "Administrator",
  "Automatic version bump",
  "Bootstrap",
  "Scheduled",
  "System",
];

/** The `adminActivity.actorLabel` select key for an actor label. */
export function jobActorKey(label: string): string {
  return label.toLowerCase().replace(/\s+/g, "_");
}
