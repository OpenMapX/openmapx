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
