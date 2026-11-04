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
const TRAIN_NUMBER_SUFFIX = /\((?:Zug-?Nr\.?\s*)?(\d+)\)$/i;
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
  // The last opening bracket starts the suffix, if anything; found directly
  // rather than by a pattern that backtracks over every earlier bracket.
  const open = name.lastIndexOf("(");
  const head = open > 0 ? name.slice(0, open).trimEnd() : "";
  if (head) {
    const numbered = name.slice(open).match(TRAIN_NUMBER_SUFFIX);
    // Or the source cut the name off inside a bracket, as in RMV's "RE 1 (RR".
    const cutOff = !name.includes(")", open);
    if (numbered || cutOff) {
      name = head;
      trainNumber = numbered?.[1];
    }
  }
  const prefix = operator?.trim();
  if (prefix && name.toLowerCase().startsWith(`${prefix.toLowerCase()} `)) {
    const rest = name.slice(prefix.length + 1).trimStart();
    if (LINE_DESIGNATION.test(rest)) name = rest;
  }
  return trainNumber ? { name, trainNumber } : { name };
}
