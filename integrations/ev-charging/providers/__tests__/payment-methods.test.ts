import { describe, expect, it } from "vitest";
import { formatPaymentMethods } from "../station-mapper.js";

describe("formatPaymentMethods", () => {
  it("keeps German umlauts inside the word", () => {
    // An ASCII \b\w boundary treats "ä" as a separator and capitalises the "t"
    // after it, which rendered "Debitkarte (LesegeräT)".
    expect(formatPaymentMethods(["debitkarte (lesegerät)"])).toBe("Debitkarte (Lesegerät)");
    expect(formatPaymentMethods(["ladesäule"])).toBe("Ladesäule");
  });

  it("upper-cases acronyms inside a compound value", () => {
    // The brand table was only consulted for the whole string, so "nfc" nested
    // in a compound fell through to title casing and became "Nfc".
    expect(formatPaymentMethods(["kreditkarte (nfc)"])).toBe("Kreditkarte (NFC)");
    expect(formatPaymentMethods(["rfid-karte"])).toBe("RFID-Karte");
    expect(formatPaymentMethods(["nfc"])).toBe("NFC");
  });

  it("still renders whole-value brand spellings", () => {
    expect(formatPaymentMethods(["apple_pay"])).toBe("Apple Pay");
    expect(formatPaymentMethods(["googlepay"])).toBe("Google Pay");
    expect(formatPaymentMethods(["paypal"])).toBe("PayPal");
  });

  it("title-cases ordinary words and joins, de-duplicating", () => {
    expect(formatPaymentMethods(["mastercard", "debit cards", "mastercard"])).toBe(
      "Mastercard, Debit Cards",
    );
    expect(formatPaymentMethods(["sonstige"])).toBe("Sonstige");
  });

  it("drops empty entries", () => {
    expect(formatPaymentMethods(["", "  ", "nfc"])).toBe("NFC");
    expect(formatPaymentMethods([])).toBe("");
  });
});
