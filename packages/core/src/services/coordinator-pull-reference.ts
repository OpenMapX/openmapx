/** Docker reference identity for the fixed sibling-pull refusal only. Never
 * rewrites an operation or authorizes an image/container. Unsupported forms
 * fail closed. Follows distribution/reference normalize.go, ParseDockerRef. */
import { serviceImageReferenceSchema } from "@openmapx/extension-contracts/service";
export function coordinatorPullReferenceIdentity(reference: string): string {
  serviceImageReferenceSchema.parse(reference);
  const [tagged, digest] = reference.split("@");
  if (!tagged || /^[a-f0-9]{64}$/.test(tagged))
    throw Error("Unsupported coordinator image reference");
  const colon = tagged.lastIndexOf(":"),
    slash = tagged.lastIndexOf("/"),
    hasTag = colon > slash;
  const name = hasTag ? tagged.slice(0, colon) : tagged,
    tag = hasTag ? tagged.slice(colon + 1) : "latest";
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag))
    throw Error("Unsupported coordinator image tag");
  const parts = name.split("/"),
    first = parts[0]!;
  let registry = "docker.io",
    repository = name;
  if (parts.length > 1 && (first === "localhost" || /[.:]/.test(first))) {
    registry = first === "index.docker.io" ? "docker.io" : first;
    repository = parts.slice(1).join("/");
  }
  if (
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::[0-9]{1,5})?$/.test(
      registry,
    )
  )
    throw Error("Unsupported coordinator registry");
  if (registry === "docker.io" && !repository.includes("/")) repository = `library/${repository}`;
  if (
    repository.length > 255 ||
    !repository.split("/").every((part) => /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/.test(part))
  )
    throw Error("Unsupported coordinator repository");
  return `${registry}/${repository}${digest ? `@${digest}` : `:${tag}`}`;
}
