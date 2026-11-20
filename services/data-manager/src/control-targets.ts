/** The services data-manager's own executions lease: itself, and MOTIS with
 * its staging slot and feed proxy for transit work (`dataExecutionTargetIds`). */
export const DATA_MANAGER_CONTROL_SERVICE_IDS = [
  "data-manager",
  "motis",
  "motis-feed-proxy",
  "motis-staging",
] as const;
