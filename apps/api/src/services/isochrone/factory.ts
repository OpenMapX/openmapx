import type { IsochroneProvider } from "./provider.js";
import { valhallaIsochroneProvider } from "./valhalla.js";

type ProviderName = "valhalla";

const providers: Record<ProviderName, IsochroneProvider> = {
  valhalla: valhallaIsochroneProvider,
};

function isProviderName(value: string): value is ProviderName {
  return value in providers;
}

let cached: IsochroneProvider | null = null;

export function getIsochroneProvider(): IsochroneProvider {
  if (cached) return cached;

  const name = (process.env.ISOCHRONE_PROVIDER ?? "valhalla").trim().toLowerCase();

  if (!isProviderName(name)) {
    throw new Error(
      `Unknown ISOCHRONE_PROVIDER: "${name}". Valid options: ${Object.keys(providers).join(", ")}`,
    );
  }

  cached = providers[name];
  return cached;
}
