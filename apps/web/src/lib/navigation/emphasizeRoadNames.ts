export interface InstructionPart {
  text: string;
  /** A road the instruction names, which the banner sets in bold. */
  road: boolean;
}

/**
 * Splits a maneuver instruction around the roads it names, so the banner can
 * make "Alexanderstraße/B 1" the line's headline and keep the verb around it
 * quiet. A road's name and refs often appear joined by "/" in the text; the
 * longest match wins, and a name the text doesn't contain is ignored.
 */
export function emphasizeRoadNames(
  instruction: string,
  roadNames: readonly string[] | undefined,
): InstructionPart[] {
  const names = (roadNames ?? []).map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) return [{ text: instruction, road: false }];
  const candidates = [names.join("/"), ...names]
    .filter((candidate, index, all) => all.indexOf(candidate) === index)
    .sort((a, b) => b.length - a.length);

  const parts: InstructionPart[] = [];
  let rest = instruction;
  while (rest) {
    let best: { index: number; name: string } | null = null;
    for (const name of candidates) {
      const index = rest.indexOf(name);
      if (index !== -1 && (best === null || index < best.index)) best = { index, name };
    }
    if (!best) break;
    if (best.index > 0) parts.push({ text: rest.slice(0, best.index), road: false });
    parts.push({ text: best.name, road: true });
    rest = rest.slice(best.index + best.name.length);
  }
  if (rest) parts.push({ text: rest, road: false });
  return parts;
}

/**
 * A routing engine writes each instruction as a sentence ("Turn left onto
 * Hauptstraße."). A banner reads like a sign, so the closing full stop goes.
 */
export function bannerInstruction(instruction: string): string {
  return instruction.replace(/\s*\.$/, "");
}
