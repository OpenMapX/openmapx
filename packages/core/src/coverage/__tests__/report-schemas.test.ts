import { describe, expectTypeOf, it } from "vitest";
import type z from "zod/v4";
import type {
  coverageRegionsResponseSchema,
  coverageReportSchema,
  coverageSourceDetailSchema,
} from "../report-schemas";
import type { CoverageRegionsResponse, CoverageReport, CoverageSourceDetail } from "../types";

describe("coverage reply schemas", () => {
  it("describe exactly the read-model types the administration page renders", () => {
    expectTypeOf<z.output<typeof coverageReportSchema>>().toEqualTypeOf<CoverageReport>();
    expectTypeOf<
      z.output<typeof coverageRegionsResponseSchema>
    >().toEqualTypeOf<CoverageRegionsResponse>();
    expectTypeOf<
      z.output<typeof coverageSourceDetailSchema>
    >().toEqualTypeOf<CoverageSourceDetail>();
  });
});
