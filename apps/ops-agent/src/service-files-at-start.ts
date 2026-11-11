import { services } from "@openmapx/core/server";

/**
 * A service file report line as the agent's log has it: a warning marked
 * with ⚠, as the CLI marks one, an info line as it is. The log is stderr
 * either way; stdout carries the agent's audit events.
 */
export function agentLogLine(line: services.ServiceFileReportLine): string {
  return line.level === "warn" ? `⚠ ${line.message}` : line.message;
}

/**
 * What the agent's log says about the service files when it starts: the
 * overrides in use, flagged and ignored. Never throws: an unusable override
 * fails the next render instead.
 */
export function describeServiceFilesAtStart(
  infraDir: string,
  // Under OPENMAPX_RELEASE=local none: the bundle's files count as the checkout's.
  release: services.ReleaseServiceFiles | null = services.renderedEmbeddedReleaseServiceFiles(),
): services.ServiceFileReportLine[] {
  if (!release) return [];
  try {
    const overrides = services.readServiceOverrides(infraDir, release);
    return services.describeServiceFiles({
      release,
      overrides,
      stale: services.staleOverrides(infraDir, overrides, { record: false }),
    });
  } catch (error) {
    return [{ level: "warn", message: (error as Error).message }];
  }
}
