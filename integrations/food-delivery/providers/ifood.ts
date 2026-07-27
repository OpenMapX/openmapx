import { withAffiliate } from "../affiliate.js";
import { term } from "../slug.js";
import type { DeliveryProvider } from "../types.js";

export const ifoodProvider: DeliveryProvider = {
  id: "ifood",
  name: "iFood",
  homepage: "https://www.ifood.com.br/",
  color: "#EA1D2C",
  fallbackKind: "search",
  regions: ["br"],
  build(q, config) {
    // `/busca?q=` is iFood's documented search path (address-first SPA).
    return withAffiliate("ifood", `https://www.ifood.com.br/busca?q=${term(q)}`, config);
  },
};
