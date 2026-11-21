import type {
  DeliveryEvidence,
  DeliveryLinkKind,
  DeliveryOption,
  DeliveryProviderInfo,
} from "../types/delivery";
import type { Place } from "../types/place";
import { deliveryProviderIdForHost } from "./deliveryProviderHosts";

const PARTNER_ALIASES: Record<string, string> = {
  ubereats: "ubereats",
  uber: "ubereats",
  wolt: "wolt",
  lieferando: "lieferando",
  lieferandode: "lieferando",
};

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function exactPath(providerId: string, pathname: string): boolean {
  const path = pathname.toLowerCase();
  if (providerId === "ubereats") return /^(\/[a-z]{2})?\/store\/[^/]+\/[^/]+\/?$/.test(path);
  if (providerId === "wolt") {
    return /^\/[a-z]{2}\/[a-z]{3}\/[^/]+\/restaurant\/[^/]+/.test(path);
  }
  if (providerId === "lieferando") return /^\/(speisekarte|menu)\/[^/]+\/?$/.test(path);
  if (providerId === "doordash") return /^\/store\/[^/]+(\/[^/]+)?\/?$/.test(path);
  if (providerId === "grubhub") return /^\/restaurant\/[^/]+\/?$/.test(path);
  if (providerId === "deliveroo") return /^\/menu\/[^/]+\/[^/]+\/[^/]+\/?$/.test(path);
  if (providerId === "justeat") return /^\/restaurants-[^/]+\/menu\/?$/.test(path);
  if (providerId === "foodpanda") return /^\/restaurant\/[^/]+\/[^/]+\/?$/.test(path);
  if (providerId === "ifood") return /^\/delivery\/[^/]+\/[^/]+\/[^/]+\/?$/.test(path);
  if (providerId === "pedidosya") return /^\/restaurantes\/[^/]+\/[^/]+-menu\/?$/.test(path);
  if (providerId === "talabat") return /^\/[^/]+\/restaurant\/[^/]+/.test(path);
  return false;
}

export interface ClassifiedDeliveryUrl {
  providerId: string;
  linkKind: DeliveryLinkKind;
  url: string;
}

/** Strictly classify a contributed provider URL without guessing a venue slug. */
export function classifyDeliveryUrl(input: string): ClassifiedDeliveryUrl | null {
  const raw = input.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port) return null;
  const host = normalizeHost(url.hostname);
  const providerId = deliveryProviderIdForHost(host);
  if (!providerId) return null;
  url.protocol = "https:";
  url.hash = "";
  return {
    providerId,
    linkKind: exactPath(providerId, url.pathname) ? "exact" : "browse",
    url: url.toString(),
  };
}

function partnerIds(value?: string): Set<string> {
  const ids = new Set<string>();
  for (const part of value?.split(/[;,]/) ?? []) {
    const key = part
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    const id = PARTNER_ALIASES[key];
    if (id) ids.add(id);
  }
  return ids;
}

function deliveryIsNo(value?: string): boolean {
  return /^(no|false|0)$/i.test(value?.trim() ?? "");
}

function directSignals(place: Place): Array<{ value: string; evidence: DeliveryEvidence }> {
  const tags = place.osmTags ?? {};
  const signals: Array<{ value: string | undefined; evidence: DeliveryEvidence }> = [
    { value: tags["delivery:website"], evidence: "provider-url" },
    { value: tags["website:orders"], evidence: "provider-url" },
    { value: tags["takeaway:website"], evidence: "provider-url" },
    { value: tags["contact:ubereats"], evidence: "provider-url" },
    { value: tags["contact:wolt"], evidence: "provider-url" },
    { value: tags["contact:lieferando"], evidence: "provider-url" },
    { value: tags["contact:website"], evidence: "provider-url" },
    { value: place.website, evidence: "provider-url" },
  ];
  return signals.filter((item): item is { value: string; evidence: DeliveryEvidence } =>
    Boolean(item.value),
  );
}

function normalizeDirectOrderUrl(input?: string): string | null {
  if (!input?.trim() || classifyDeliveryUrl(input)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** Prefer explicit OSM order URLs over heuristic homepage discovery. */
export function resolveOsmOrderUrl(place: Place): string | null {
  const tags = place.osmTags ?? {};
  for (const value of [
    tags["delivery:website"],
    tags["website:orders"],
    tags["takeaway:website"],
  ]) {
    const url = normalizeDirectOrderUrl(value);
    if (url) return url;
  }
  return null;
}

/** Merge provider catalog/resolver data with restaurant-specific OSM evidence. */
export function buildDeliveryOptions(
  place: Place,
  providers: readonly DeliveryProviderInfo[],
  discoveredProviderUrls: readonly string[] = [],
): DeliveryOption[] {
  const exactByProvider = new Map<string, ClassifiedDeliveryUrl>();
  for (const signal of [
    ...directSignals(place),
    ...discoveredProviderUrls.map((value) => ({ value, evidence: "provider-url" as const })),
  ]) {
    const classified = classifyDeliveryUrl(signal.value);
    if (!classified) continue;
    const current = exactByProvider.get(classified.providerId);
    if (!current || (current.linkKind !== "exact" && classified.linkKind === "exact")) {
      exactByProvider.set(classified.providerId, classified);
    }
  }
  const partners = partnerIds(place.osmTags?.["delivery:partner"]);
  const noDelivery = deliveryIsNo(place.osmTags?.delivery);

  const options = providers.flatMap<DeliveryOption>((provider) => {
    const exact = exactByProvider.get(provider.id);
    if (exact?.linkKind === "exact") {
      return [
        {
          ...provider,
          linkKind: "exact",
          url: exact.url,
          availability: "confirmed",
          evidence: "provider-url",
        },
      ];
    }
    if (provider.linkKind === "exact") {
      return [{ ...provider, availability: "confirmed", evidence: "resolver" }];
    }
    if (noDelivery) return [];
    if (partners.has(provider.id)) {
      return [{ ...provider, availability: "confirmed", evidence: "delivery-partner" }];
    }
    return [{ ...provider, availability: "unknown", evidence: "fallback" }];
  });

  const rank = (option: DeliveryOption): number => {
    if (option.linkKind === "exact") return 0;
    if (option.availability === "confirmed") return 1;
    return option.linkKind === "search" ? 2 : 3;
  };
  return options.sort((a, b) => rank(a) - rank(b));
}
