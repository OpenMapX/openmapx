"use client";

/** Formats a fuel price as "X.XX⁹ €" with the last digit in superscript style. */
export function FuelPrice({ value }: { value: number }) {
  const str = value.toFixed(3);
  return (
    <span style={{ display: "inline-flex", alignItems: "flex-start" }}>
      <span>{str.slice(0, -1)}</span>
      <span style={{ fontSize: "0.65em", marginTop: "0.2em" }}>{str.slice(-1)}</span>
      <span>&nbsp;€</span>
    </span>
  );
}
