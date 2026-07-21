import type { ConnectorStandard, CurrentStandard } from "../types/ev.js";

const DC_STANDARDS = new Set<ConnectorStandard>(["ccs2", "ccs1", "chademo", "tesla_ccs", "gbt_dc"]);

/** Ordered longest-first so "type2_combo" matches ccs2 before "type2". */
const TYPE_PATTERNS: Array<[RegExp, ConnectorStandard]> = [
  [/t2.?combo|type.?2.?combo|62196.?t2.?combo|ccs.?2|^ccs$|combo.?2|combo.?ccs/, "ccs2"],
  [/t1.?combo|type.?1.?combo|ccs.?1|combo.?1/, "ccs1"],
  [/chademo|charge.?de.?move|62196.?3|type.?4/, "chademo"],
  [/tesla/, "tesla_ccs"],
  [/gbt.?dc|gb.?t.?dc/, "gbt_dc"],
  [/gbt.?ac|gb.?t.?ac|gbt/, "gbt_ac"],
  [/62196.?t3|type.?3/, "type3"],
  [/62196.?t2|type.?2|mennekes|^t2$/, "type2"],
  [/62196.?t1|type.?1|j1772|^t1$/, "type1"],
];

/**
 * Normalise a free-form connector `type` (and optional `currentType`) from any
 * charger source into a canonical `{ standard, current }`, or `null` when the
 * type is unrecognised. `current` is inferred from the standard (DC standards
 * are always DC) unless the raw current disambiguates an AC/DC-capable plug.
 */
export function normalizeConnector(
  rawType: string | undefined,
  rawCurrent?: string | undefined,
): { standard: ConnectorStandard; current: CurrentStandard } | null {
  if (!rawType) return null;
  const key = rawType.toLowerCase().replace(/[\s_\-()/]+/g, "");
  const match = TYPE_PATTERNS.find(([re]) => re.test(key));
  if (!match) return null;
  const standard = match[1];
  const current: CurrentStandard = DC_STANDARDS.has(standard)
    ? "dc"
    : rawCurrent && /dc/i.test(rawCurrent)
      ? "dc"
      : "ac";
  return { standard, current };
}
