import {
  type AttributionPolicy,
  type AttributionSurface,
  canonicalLicenseExpression,
  type LicenseBinding,
  parseAttributionPolicy,
} from "@openmapx/mobility-core/licensing";
import parseExpression, { type Info as Expression } from "spdx-expression-parse";

export interface PlacementDecision {
  placement: "visible" | "details";
  basis: AttributionPolicy["basis"];
  reason: string;
  evidenceUrls: readonly string[];
  compactText?: string;
  logo?: AttributionPolicy["logo"];
  prominence?: AttributionPolicy["prominence"];
  includePublisher?: true;
}

/** Exact grants reviewed for direct, associated full-credit details. Not a permission catalogue. */
const DETAILS_EVIDENCE: Readonly<Record<string, string>> = {
  "CC-BY-4.0": "https://creativecommons.org/licenses/by/4.0/legalcode.en",
  "CC-BY-SA-4.0": "https://creativecommons.org/licenses/by-sa/4.0/legalcode.en",
  "CC0-1.0": "https://creativecommons.org/publicdomain/zero/1.0/legalcode.en",
  "DL-DE-BY-2.0": "https://www.govdata.de/informationen/faq",
  "DL-DE-ZERO-2.0": "https://www.govdata.de/dl-de/zero-2-0",
  "NLOD-2.0": "https://data.norge.no/nlod/en/2.0",
  "OGL-UK-3.0": "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  "OGL-Canada-2.0": "https://open.canada.ca/en/open-government-licence-canada",
  "etalab-2.0": "https://www.etalab.gouv.fr/wp-content/uploads/2018/11/open-licence.pdf",
  "OGDL-Taiwan-1.0": "https://data.gov.tw/license",
  "PDDL-1.0": "https://opendatacommons.org/licenses/pddl/1-0/",
  "CDLA-Permissive-2.0": "https://spdx.org/licenses/CDLA-Permissive-2.0.html",
  "Apache-2.0": "https://www.apache.org/licenses/LICENSE-2.0",
  "BSD-2-Clause": "https://spdx.org/licenses/BSD-2-Clause.html",
  "BSD-3-Clause": "https://spdx.org/licenses/BSD-3-Clause.html",
};

const conservative = (): PlacementDecision => ({
  placement: "visible",
  basis: "unresolved",
  reason: "No reviewed direct-details permission for this exact grant/product",
  evidenceUrls: [],
});

/** Apply producer-captured source exceptions before exact, scope-aware licence defaults. */
export function resolveBindingPlacement(
  binding: LicenseBinding,
  surface: AttributionSurface,
): PlacementDecision {
  if (binding.attribution !== undefined) {
    const policy = parseAttributionPolicy(binding.attribution);
    if (!policy) return conservative();
    if (policy.surfaces.includes(surface)) return policy;
  }
  if (binding.scope === "software") {
    return {
      placement: "details",
      basis: "recommendation",
      reason: "Software notices remain in legal/source details; they do not license output data",
      evidenceUrls: [],
    };
  }
  const license = binding.license;
  if (license.kind === "public-domain" || license.kind === "status") {
    return {
      placement: "details",
      basis: "recommendation",
      reason:
        "Retain declared status and voluntary provenance in associated details; service terms remain separate",
      evidenceUrls: license.url ? [license.url] : [],
    };
  }
  if (license.kind !== "spdx") return conservative();
  const expression = canonicalLicenseExpression(license.expression);
  if (!expression) return conservative();
  const evidence = new Set<string>();
  const pending: Expression[] = [parseExpression(expression)];
  while (pending.length) {
    const node = pending.pop();
    if (!node) break;
    if ("license" in node) {
      // OR is not a selection of a licence. Every offered branch must be safe
      // until the producer captures an actual selected grant. WITH is separate.
      const url = DETAILS_EVIDENCE[node.license];
      if (!url || node.exception || node.plus) return conservative();
      evidence.add(url);
    } else pending.push(node.left, node.right);
  }
  return {
    placement: "details",
    basis: "licence",
    reason: "Reviewed exact licence supports complete, conspicuous one-action details",
    evidenceUrls: [...evidence],
  };
}
