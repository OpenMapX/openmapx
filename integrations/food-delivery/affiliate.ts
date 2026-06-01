import { enc } from "./slug.js";
import type { DeliveryProviderConfig } from "./types.js";

/**
 * Apply an operator-configured affiliate wrapper, if one exists for this
 * provider. The template must contain `{url}`, replaced with the URL-encoded
 * destination. No template ⇒ the plain link is returned unchanged. Every
 * provider's `build` runs its final URL through this so an operator can plug in
 * an Awin / Impact / Partnerize deep-link wrapper without us hard-coding a
 * network.
 */
export function withAffiliate(id: string, url: string, config: DeliveryProviderConfig): string {
  const tmpl = config.affiliateTemplates?.[id]?.trim();
  if (!tmpl?.includes("{url}")) return url;
  return tmpl.replace("{url}", enc(url));
}
