import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { CreditSources } from "../../features/record.js";

/** The crowd credit an instance's `/sources` states, as OpenMapX reads it. */
export const CROWD_CREDIT: Attribution = {
  sourceId: "crowd",
  name: "OpenConditions contributors at oc.example",
  url: "https://oc.example/reports",
  licensing: {
    version: 1,
    declarations: [{ text: "ODbL-1.0" }],
    bindings: [
      {
        scope: "data",
        subject: "OpenConditions contributors at oc.example",
        license: { kind: "spdx", expression: "ODbL-1.0" },
      },
    ],
  },
};

/** Live sources that state the crowd's credit and give no links. */
export const CROWD_SOURCES: CreditSources = {
  link: () => undefined,
  crowd: () => CROWD_CREDIT,
};

/** Synthetic expanded observation capture, independent of the later /sources catalogue. */
export const CROWD_PROVENANCE = {
  sourceId: "@fused",
  attribution: { provider: "Fusion winner" },
  mergedSources: [
    {
      source: "crowd",
      recordId: "oc:observation:crowd:report",
      attribution: {
        provider: CROWD_CREDIT.name,
        name: CROWD_CREDIT.name,
        url: CROWD_CREDIT.url,
        licensing: CROWD_CREDIT.licensing,
      },
    },
  ],
};

/** The captured observation preserves the supplied notice separately from its display name. */
export const CROWD_READING_CREDIT: Attribution = {
  ...CROWD_CREDIT,
  attributionText: CROWD_CREDIT.name,
};
