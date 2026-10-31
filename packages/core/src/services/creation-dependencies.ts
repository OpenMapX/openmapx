/** The services Compose may create for a fixed creation command. Selection and
 * data producers are deliberately separate from actual depends_on edges. */
import type { LoadedService } from "./types";

const id = /^[a-z0-9][a-z0-9-]{0,63}$/;
const unavailable = () => Error("Service creation dependencies unavailable");
function closure(targets: readonly string[], dependencies: ReadonlyMap<string, readonly string[]>) {
  const found = new Set<string>(),
    pending = [...targets];
  for (let index = 0; index < pending.length; index++) {
    const current = pending[index]!;
    if (!id.test(current)) throw unavailable();
    if (found.has(current)) continue;
    found.add(current);
    if (found.size > 256) throw unavailable();
    const next = dependencies.get(current);
    if (!next) throw unavailable();
    for (const dependency of next) if (!found.has(dependency)) pending.push(dependency);
    if (pending.length > 65536) throw unavailable();
  }
  return [...found].sort();
}
export function serviceCreationDependencyIds(
  services: readonly LoadedService[],
  targets: readonly string[],
) {
  if (
    services.length > 256 ||
    new Set(services.map((service) => service.manifest.id)).size !== services.length
  )
    throw unavailable();
  return closure(
    targets,
    new Map(
      services.map((service) => [
        service.manifest.id,
        (service.manifest.container.dependsOn ?? []).map((dependency) => dependency.service),
      ]),
    ),
  );
}
export function composeCreationDependencyIds(config: unknown, targets: readonly string[]) {
  const values = (config as { services?: unknown } | null)?.services;
  if (
    !values ||
    typeof values !== "object" ||
    Array.isArray(values) ||
    Object.keys(values).length > 256
  )
    throw unavailable();
  const dependencies = new Map<string, readonly string[]>();
  for (const [service, value] of Object.entries(values)) {
    if (!id.test(service) || !value || typeof value !== "object" || Array.isArray(value))
      throw unavailable();
    const raw = (value as { depends_on?: unknown }).depends_on;
    const next =
      raw === undefined
        ? []
        : Array.isArray(raw)
          ? raw
          : raw && typeof raw === "object"
            ? Object.keys(raw)
            : null;
    if (
      !next ||
      next.length > 256 ||
      next.some((dependency) => typeof dependency !== "string" || !id.test(dependency))
    )
      throw unavailable();
    dependencies.set(service, next as string[]);
  }
  return closure(targets, dependencies);
}
