import { withAffiliate } from "../affiliate.js";
import { term } from "../slug.js";
import type { DeliveryProvider } from "../types.js";

export const doordashProvider: DeliveryProvider = {
  id: "doordash",
  name: "DoorDash",
  homepage: "https://www.doordash.com/",
  color: "#FF3008",
  regions: ["us", "ca", "au", "nz", "jp"],
  build(q, config) {
    return withAffiliate("doordash", `https://www.doordash.com/search/store/${term(q)}/`, config);
  },
};
