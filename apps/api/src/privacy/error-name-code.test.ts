import { expect, it } from "vitest";
import { errorNameCode } from "./error-name-code";

it("stores an error's name as an UPPER_SNAKE code and never its message", () => {
  expect(errorNameCode(new TypeError("secret detail"), "FALLBACK")).toBe("TYPE_ERROR");
  expect(errorNameCode(new Error("x"), "FALLBACK")).toBe("ERROR");
  expect(errorNameCode(Object.assign(new Error("x"), { name: "SMTPError" }), "F")).toBe(
    "SMTPERROR",
  );
  expect(errorNameCode(Object.assign(new Error("x"), { name: "mail-transport.down" }), "F")).toBe(
    "MAIL_TRANSPORT_DOWN",
  );
  expect(errorNameCode(Object.assign(new Error("x"), { name: "  " }), "FALLBACK")).toBe("FALLBACK");
  expect(errorNameCode("not an error", "FALLBACK")).toBe("FALLBACK");
});
