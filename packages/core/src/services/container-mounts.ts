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

/**
 * The containers, running or stopped, that still mount a file or directory
 * from the checkout's `services/`: created by a release before services
 * mounted the release's files. Traefik's dynamic directory has its own notice.
 */
export function containersOnCheckoutServiceFiles(
  rootDir: string,
  mounts: readonly ContainerBindMounts[],
): string[] {
  let end = rootDir.length;
  while (end > 0 && rootDir.charCodeAt(end - 1) === 47) end--;
  const services = `${rootDir.slice(0, end)}/services/`;
  const traefikDynamic = `${services}traefik/config/dynamic`;
  return mounts
    .filter((mount) =>
      mount.sources.some(
        (source) =>
          source.startsWith(services) &&
          source !== traefikDynamic &&
          !source.startsWith(`${traefikDynamic}/`),
      ),
    )
    .map((mount) => mount.name)
    .sort();
}

export function describeContainersOnCheckoutServiceFiles(names: readonly string[]): string[] {
  if (names.length === 0) return [];
  return [
    `${names.length} container${names.length === 1 ? "" : "s"} still mount${names.length === 1 ? "s" : ""} service files from the checkout: ${names.join(", ")}. They keep working with the checkout's files until recreated, which then mounts the release's files and your overrides; recreate each when a short restart suits you: pnpm openmapx services update <service>, or Recreate on Admin → Services. A later release stops mounting the checkout into the operations agent and waits for this.`,
  ];
}
