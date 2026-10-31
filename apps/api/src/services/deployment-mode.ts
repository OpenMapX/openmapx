/** Deployment configuration describes intent, never permission or live host reachability. */
export function hostControlConfigured(): boolean {
  return Boolean(process.env.OPS_AGENT_URL?.trim() && process.env.OPS_AGENT_TOKEN_FILE?.trim());
}
export function isSelfHostedDeployment(): boolean {
  return (
    Boolean(process.env.OPS_AGENT_URL?.trim() || process.env.OPS_AGENT_TOKEN_FILE?.trim()) ||
    process.env.OPENMAPX_APPLIED_SERVICES !== undefined
  );
}
