/**
 * Sources decorate a line's name with the train's number or their own
 * prefixes: "RE1 (26826)", "RB48 (Zug-Nr. 17358)", "DB S11 (Zug-Nr. 33192)",
 * or cut it off mid-word as in "RE 1 (RR". Riders know the line as "RE1" or
 * "S11"; the train number is a separate fact.
 */
export interface LineName {
  /** The line as riders know it, e.g. "S11". */
  name: string;
  /** The train's number when the source wrote it into the name, e.g. "33192". */
  trainNumber?: string;
}

/** A train number in brackets at the end: "(26826)", "(Zug-Nr. 33192)". */
const TRAIN_NUMBER_SUFFIX = /^(.*\S)\s*\((?:Zug-?Nr\.?\s*)?(\d+)\)$/i;
/** An opening bracket the source cut off, as in RMV's "RE 1 (RR". */
const UNCLOSED_SUFFIX = /^(.*\S)\s*\([^)]*$/;
/** A line designation: letters then a number, as in "S11" or "RE 1". */
const LINE_DESIGNATION = /^\p{L}+\s?\d/u;

/**
 * Split a source's line name into the line riders know and the train number.
 * `operator` is the source's operator or product label (hafas-client's
 * `productName`, e.g. "DB"); a leading copy of it is dropped when a line
 * designation follows ("DB S11" becomes "S11", "ICE 203" stays).
 */
export function splitLineName(raw: string, operator?: string): LineName {
  let name = raw.trim();
  let trainNumber: string | undefined;
  const numbered = name.match(TRAIN_NUMBER_SUFFIX);
  if (numbered) {
    name = numbered[1];
    trainNumber = numbered[2];
  } else {
    const cut = name.match(UNCLOSED_SUFFIX);
    if (cut) name = cut[1];
  }
  const prefix = operator?.trim();
  if (prefix && name.toLowerCase().startsWith(`${prefix.toLowerCase()} `)) {
    const rest = name.slice(prefix.length + 1).trimStart();
    if (LINE_DESIGNATION.test(rest)) name = rest;
  }
  return trainNumber ? { name, trainNumber } : { name };
}
