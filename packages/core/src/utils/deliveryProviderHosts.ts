/** Canonical provider host registry shared by evidence parsing and crawl guards. */
export const DELIVERY_PROVIDER_HOSTS: Readonly<Record<string, readonly string[]>> = {
  ubereats: ["ubereats.com"],
  wolt: ["wolt.com"],
  lieferando: ["lieferando.de", "lieferando.at"],
  doordash: ["doordash.com"],
  deliveroo: ["deliveroo.co.uk", "deliveroo.com", "deliveroo.de"],
  justeat: ["just-eat.co.uk", "just-eat.ie"],
  grubhub: ["grubhub.com"],
  foodpanda: [
    "foodpanda.com",
    "foodpanda.sg",
    "foodpanda.my",
    "foodpanda.hk",
    "foodpanda.com.tw",
    "foodpanda.pk",
    "foodpanda.com.bd",
    "foodpanda.ph",
    "foodpanda.com.kh",
    "foodpanda.la",
    "foodpanda.com.mm",
  ],
  glovo: ["glovoapp.com"],
  ifood: ["ifood.com.br"],
  rappi: [
    "rappi.com.mx",
    "rappi.com.co",
    "rappi.com.br",
    "rappi.com.ar",
    "rappi.com.cl",
    "rappi.com.pe",
    "rappi.com.ec",
    "rappi.com.uy",
    "rappi.com.cr",
  ],
  pedidosya: [
    "pedidosya.com",
    "pedidosya.cl",
    "pedidosya.com.ar",
    "pedidosya.com.uy",
    "pedidosya.com.bo",
    "pedidosya.com.py",
    "pedidosya.com.pe",
    "pedidosya.com.ec",
  ],
  swiggy: ["swiggy.com"],
  zomato: ["zomato.com"],
  talabat: ["talabat.com", "iraq.talabat.com"],
};

/** Return the provider that owns a host, including provider-owned subdomains. */
export function deliveryProviderIdForHost(hostname: string): string | null {
  const host = hostname
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
  return (
    Object.entries(DELIVERY_PROVIDER_HOSTS).find(([, hosts]) =>
      hosts.some((providerHost) => host === providerHost || host.endsWith(`.${providerHost}`)),
    )?.[0] ?? null
  );
}
