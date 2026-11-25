import z from "zod/v4";
import { artifactMetadataSchema } from "./artifact";
import { extensionManifestSchema } from "./extension";
import { communityIntegrationManifestSchema } from "./integration";
import { PLATFORM_VERSION } from "./platform";
import { communityServiceManifestSchema } from "./service";

/**
 * Structural editor schemas for community authors, keyed by the extension
 * protocol version rather than the package version. Use the validators for
 * semantic and community-policy checks.
 */
export function createAuthoringSchemas() {
  return Object.fromEntries(
    Object.entries({
      integration: communityIntegrationManifestSchema,
      service: communityServiceManifestSchema,
      extension: extensionManifestSchema,
      artifact: artifactMetadataSchema,
    }).map(([name, schema]) => [
      name,
      {
        ...z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
        $id: `https://openmapx.org/schemas/extension-contracts/${PLATFORM_VERSION}/${name}.json`,
        $comment:
          "Structural authoring schema. Runtime validation additionally checks structured licensing, media hosts, component references, compatibility and community policy. This identifier does not imply hosted schema availability.",
      },
    ]),
  );
}
