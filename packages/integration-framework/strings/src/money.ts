/** Formatters by locale, currency and minimum digits: a pricing table formats many prices alike. */
const formatters = new Map<string, Intl.NumberFormat>();

function formatterFor(locale: string, currency: string, minDigits: number): Intl.NumberFormat {
  const key = `${locale}\u0000${currency}\u0000${minDigits}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    const own =
      new Intl.NumberFormat(locale, { style: "currency", currency }).resolvedOptions()
        .minimumFractionDigits ?? 2;
    const digits = Math.max(own, minDigits);
    formatter = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: Math.max(digits, 4),
    });
    formatters.set(key, formatter);
  }
  return formatter;
}

/**
 * A price in the reader's locale: the locale places the symbol, the spacing
 * and the decimal separator ("€0.39", "0,39 €"). The currency's own digits
 * are always shown, or `minDigits` when the price is quoted to more (fuel to
 * tenths of a cent: "€1.790"), and more up to four when the price has them,
 * so a per-kWh 0.389 stays 0.389. A code `Intl` does not accept is written
 * after the amount.
 */
export function formatMoney(
  amount: number,
  currency: string,
  locale: string,
  minDigits = 0,
): string {
  try {
    return formatterFor(locale, currency, minDigits).format(amount);
  } catch {
    return `${new Intl.NumberFormat(locale, {
      minimumFractionDigits: minDigits,
      maximumFractionDigits: Math.max(minDigits, 4),
    }).format(amount)} ${currency}`;
  }
}
