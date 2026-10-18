import z from "zod/v4";
import packageInfo from "../package.json";
import { artifactMetadataSchema } from "./artifact";
import { extensionManifestSchema } from "./extension";
import { integrationManifestSchema } from "./integration";
import { serviceManifestSchema } from "./service";

/** Structural editor schemas. Use the validators for semantic and community-policy checks. */
export function createAuthoringSchemas() {
  return Object.fromEntries(
    Object.entries({
      integration: integrationManifestSchema,
      service: serviceManifestSchema,
      extension: extensionManifestSchema,
      artifact: artifactMetadataSchema,
    }).map(([name, schema]) => [
      name,
      {
        ...z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
        $id: `https://openmapx.org/schemas/extension-contracts/${packageInfo.version}/${name}.json`,
        $comment:
          "Structural authoring schema. Runtime validation additionally checks structured licensing, media hosts, component references, compatibility and community policy. This identifier does not imply hosted schema availability.",
      },
    ]),
  );
}
