import { withAffiliate } from "../affiliate.js";
import { term } from "../slug.js";
import type { DeliveryProvider } from "../types.js";

export const grubhubProvider: DeliveryProvider = {
  id: "grubhub",
  name: "Grubhub",
  homepage: "https://www.grubhub.com/",
  color: "#EB1700",
  regions: ["us"],
  build(q, config) {
    return withAffiliate("grubhub", `https://www.grubhub.com/search?queryText=${term(q)}`, config);
  },
};
