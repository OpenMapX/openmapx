import { withAffiliate } from "../affiliate.js";
import { term } from "../slug.js";
import type { DeliveryProvider } from "../types.js";

export const swiggyProvider: DeliveryProvider = {
  id: "swiggy",
  name: "Swiggy",
  homepage: "https://www.swiggy.com/",
  color: "#FC8019",
  fallbackKind: "search",
  regions: ["in"],
  build(q, config) {
    // Swiggy is a client-side SPA with no deep-linkable restaurant URL; the
    // search path pre-fills the query (results render after the user sets an
    // address). Best available.
    return withAffiliate("swiggy", `https://www.swiggy.com/search?query=${term(q)}`, config);
  },
};
