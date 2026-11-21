import { describe, expect, test } from "vitest";
import { connectorStandardOf } from "../connector-standard";

describe("connectorStandardOf", () => {
  test("connectorStandardOf maps the OCPI standards the vehicles know and nothing else", () => {
    expect(connectorStandardOf("IEC_62196_T2")).toBe("type2");
    expect(connectorStandardOf("IEC_62196_T2_COMBO")).toBe("ccs2");
    expect(connectorStandardOf("IEC_62196_T1")).toBe("type1");
    expect(connectorStandardOf("IEC_62196_T1_COMBO")).toBe("ccs1");
    expect(connectorStandardOf("CHADEMO")).toBe("chademo");
    expect(connectorStandardOf("SAE_J3400")).toBe("nacs");
    expect(connectorStandardOf("TESLA_S")).toBe("nacs");
    expect(connectorStandardOf("IEC_62196_T3A")).toBe("type3");
    expect(connectorStandardOf("IEC_62196_T3C")).toBe("type3");
    expect(connectorStandardOf("GBT_AC")).toBe("gbt_ac");
    expect(connectorStandardOf("GBT_DC")).toBe("gbt_dc");
    expect(connectorStandardOf("DOMESTIC_F")).toBeUndefined();
    expect(connectorStandardOf("TESLA_R")).toBeUndefined();
    expect(connectorStandardOf("")).toBeUndefined();
  });
});
