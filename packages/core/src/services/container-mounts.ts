/** The bind mounts of one container, running or stopped. */
export interface ContainerBindMounts {
  /** Its name, without Docker's leading slash. */
  readonly name: string;
  readonly sources: readonly string[];
}

const FORMAT = '{{.Name}}{{range .Mounts}}{{if eq .Type "bind"}}\t{{.Source}}{{end}}{{end}}';

/**
 * Every container's bind sources, through `docker` (the CLI's or the agent's
 * runner, which returns stdout and throws on failure). `undefined` when
 * Docker can't tell, which callers treat as "anything may be mounted".
 */
export async function readContainerBindMounts(
  docker: (args: string[]) => Promise<string>,
): Promise<ContainerBindMounts[] | undefined> {
  try {
    const ids = (await docker(["ps", "--all", "--quiet", "--no-trunc"]))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (ids.length === 0) return [];
    return (await docker(["inspect", "--format", FORMAT, ...ids]))
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const [name = "", ...sources] = line.split("\t");
        return { name: name.replace(/^\//, ""), sources };
      });
  } catch {
    return undefined;
  }
}

/** All bind sources of `mounts`, or undefined when not known. */
export function bindSources(
  mounts: readonly ContainerBindMounts[] | undefined,
): string[] | undefined {
  return mounts?.flatMap((mount) => mount.sources);
}
