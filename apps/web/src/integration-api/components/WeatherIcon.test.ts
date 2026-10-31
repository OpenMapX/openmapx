// @vitest-environment node
import { weatherCodeToIcon } from "@openmapx/core";
import { expect, it } from "vitest";
import weatherMeteocons from "./meteocons.json";

it("bundles every meteocon the WMO code table can name", () => {
  const icons = weatherMeteocons.icons as Record<string, unknown>;
  const missing = new Set<string>();
  for (let code = 0; code <= 99; code++) {
    for (const isDay of [true, false]) {
      const name = weatherCodeToIcon(code, isDay);
      if (!(name in icons)) missing.add(name);
    }
  }
  expect([...missing]).toEqual([]);
});
