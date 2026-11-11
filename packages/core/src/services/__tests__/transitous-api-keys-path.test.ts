import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import {
  TRANSITOUS_API_KEYS_DIRECTORY,
  transitousApiKeysDirectory,
  transitousApiKeysPath,
} from "../transitous-api-keys-path";

it("names the directory data-manager mounts its Transitous API keys from", () => {
  const manifest = JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "../../../../../services/data-manager/service.json"),
      "utf8",
    ),
  ) as { bindMounts: Array<{ source: string; target: string; readOnly?: boolean }> };
  expect(manifest.bindMounts).toContainEqual(
    expect.objectContaining({
      source: `@infra:${TRANSITOUS_API_KEYS_DIRECTORY}`,
      target: "/config/transitous",
      readOnly: true,
    }),
  );
  expect(transitousApiKeysDirectory("/srv/openmapx/infra/docker")).toBe(
    join("/srv/openmapx/infra/docker", "secrets", "transitous-api-keys"),
  );
  expect(transitousApiKeysPath("/srv/openmapx/infra/docker")).toBe(
    join("/srv/openmapx/infra/docker", "secrets", "transitous-api-keys", "api-keys.json"),
  );
});
