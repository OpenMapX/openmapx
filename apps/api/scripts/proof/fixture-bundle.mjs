// A stand-in for an installed integration's built backend bundle: plain ESM
// whose only bare imports are the SDK and zod, the externals a real bundle keeps.
import { ProviderTimeoutError } from "@openmapx/integration-sdk/errors";
import { registerPlaceResolver } from "@openmapx/integration-sdk/places";
import { z } from "zod";

export async function setup(_ctx) {
  registerPlaceResolver("proof-scheme", async (id) => ({ id, resolvedBy: "fixture-bundle" }));
}

export function probe() {
  let zodError;
  try {
    z.string().parse(1);
  } catch (error) {
    zodError = error;
  }
  return { timeout: new ProviderTimeoutError(), zodError };
}
