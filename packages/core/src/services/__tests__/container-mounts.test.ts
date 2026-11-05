import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { containersOnCheckoutServiceFiles } from "../container-mounts";

it("normalizes trailing slashes without changing checkout mount classification", () => {
  expect(
    containersOnCheckoutServiceFiles("/srv/openmapx///", [
      { name: "engine", sources: ["/srv/openmapx/services/engine/config"] },
      { name: "dynamic", sources: ["/srv/openmapx/services/traefik/config/dynamic/file"] },
      { name: "other", sources: ["/different/services/config"] },
    ]),
  ).toEqual(["engine"]);
});

it("bounds work on long non-matching slash runs", async () => {
  const code = `
    const { containersOnCheckoutServiceFiles } = await import(process.argv[1]);
    containersOnCheckoutServiceFiles("/".repeat(200000) + "suffix", []);
  `;
  await expect(
    promisify(execFile)(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        code,
        new URL("../container-mounts.ts", import.meta.url).href,
      ],
      { timeout: 2000 },
    ),
  ).resolves.toBeDefined();
});
