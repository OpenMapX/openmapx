export function formatCo2Emission(
  co2Grams: number | null | undefined,
  locale: string,
): string | null {
  if (typeof co2Grams !== "number" || !Number.isFinite(co2Grams) || co2Grams < 0) return null;

  if (co2Grams >= 1000) {
    const kilograms = co2Grams / 1000;
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(kilograms)} kg CO2`;
  }

  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.round(co2Grams))} g CO2`;
}
