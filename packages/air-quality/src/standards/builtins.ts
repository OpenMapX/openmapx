import { caAqhiCurrentAdapter } from "./ca-aqhi-current";
import { cnHj6332026Adapter } from "./cn-hj633-2026";
import { euEeaCurrentAdapter } from "./eu-eea-current";
import { inNaqiCurrentAdapter } from "./in-naqi-current";
import { listStandardAdapters, registerStandardAdapter } from "./registry";
import { ukDaqiCurrentAdapter } from "./uk-daqi-current";
import { usEpa2024Adapter } from "./us-epa-2024";

export const builtInStandardAdapters = [
  usEpa2024Adapter,
  euEeaCurrentAdapter,
  ukDaqiCurrentAdapter,
  inNaqiCurrentAdapter,
  cnHj6332026Adapter,
  caAqhiCurrentAdapter,
] as const;

/** Registers the reviewed built-ins without making package import mutate global state. */
export function registerBuiltinStandardAdapters(): void {
  const registered = new Set(
    listStandardAdapters().map(({ standardId, revision }) => `${standardId}\0${revision}`),
  );
  for (const adapter of builtInStandardAdapters) {
    if (!registered.has(`${adapter.standardId}\0${adapter.revision}`))
      registerStandardAdapter(adapter);
  }
}
