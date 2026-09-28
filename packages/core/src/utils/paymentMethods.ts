// Whole-value spellings that per-word casing cannot produce.
const PAYMENT_BRAND_CASING: Record<string, string> = {
  paypal: "PayPal",
  applepay: "Apple Pay",
  "apple pay": "Apple Pay",
  googlepay: "Google Pay",
  "google pay": "Google Pay",
};

const PAYMENT_WORD_CASING: Record<string, string> = {
  nfc: "NFC",
  rfid: "RFID",
  ec: "EC",
  paypal: "PayPal",
};

/** Display one OSM or provider payment method with brand and Unicode-aware casing. */
export function formatPaymentMethodLabel(raw: string): string {
  const normalized = raw.trim().toLowerCase().replace(/_/g, " ");
  return (
    PAYMENT_BRAND_CASING[normalized] ??
    normalized.replace(
      /\p{L}[\p{L}\p{N}]*/gu,
      (word) => PAYMENT_WORD_CASING[word] ?? word.charAt(0).toUpperCase() + word.slice(1),
    )
  );
}

/** Join payment methods for compact provider summaries, without duplicates. */
export function formatPaymentMethods(methods: string[]): string {
  const seen = new Set<string>();
  const formatted: string[] = [];
  for (const raw of methods) {
    const normalized = raw.trim().toLowerCase().replace(/_/g, " ");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    formatted.push(formatPaymentMethodLabel(normalized));
  }
  return formatted.join(", ");
}
