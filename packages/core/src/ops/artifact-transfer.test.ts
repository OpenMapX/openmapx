import { expect, it } from "vitest";
import { OPS_OPERATION_KINDS } from "./contract";

it("installs only the finite API stage operations, including owner-scoped listing", () => {
  for (const action of ["create", "list", "inspect", "delete", "claim", "inspectClaim", "settle"])
    expect(OPS_OPERATION_KINDS).toContain(`artifactTransfer.${action}`);
});
