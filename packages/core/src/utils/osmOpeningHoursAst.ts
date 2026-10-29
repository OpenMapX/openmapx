/**
 * Pure, zero-dependency AST, parser, serializer, and manipulation helpers for
 * the OpenStreetMap `opening_hours` specification (v0.7.4).
 *
 * Safe to import in both browser and server bundles (Apache-2.0).
 */

export const OSM_WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;
export type OsmWeekday = (typeof OSM_WEEKDAYS)[number];

export const OSM_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
export type OsmMonth = (typeof OSM_MONTHS)[number];

export const OSM_HOLIDAYS = ["PH", "SH"] as const;
export type OsmHoliday = (typeof OSM_HOLIDAYS)[number];

export const OSM_SOLAR_EVENTS = ["dawn", "sunrise", "sunset", "dusk"] as const;
export type OsmSolarEvent = (typeof OSM_SOLAR_EVENTS)[number];

export const OSM_RULE_MODIFIERS = ["open", "closed", "off", "unknown"] as const;
export type OsmRuleModifier = (typeof OSM_RULE_MODIFIERS)[number];

export const OSM_RULE_SEPARATORS = [";", ",", "||"] as const;
export type OsmRuleSeparator = (typeof OSM_RULE_SEPARATORS)[number];

export type OsmNthValue = -5 | -4 | -3 | -2 | -1 | 1 | 2 | 3 | 4 | 5;

export interface OsmNthEntry {
  from: OsmNthValue;
  to?: OsmNthValue;
}

export interface OsmYearRange {
  from: number;
  to?: number;
  openEnd?: boolean;
  step?: number;
}

export interface OsmDateOffset {
  weekdayOffset?: {
    positive: boolean;
    weekday: OsmWeekday;
  };
  dayOffset?: number;
}

export type OsmDateEndpoint =
  | {
      kind: "calendar";
      year?: number;
      month: OsmMonth;
      day: number;
    }
  | {
      kind: "nthWeekday";
      year?: number;
      month: OsmMonth;
      weekday: OsmWeekday;
      nth: OsmNthValue;
    }
  | {
      kind: "easter";
      year?: number;
    };

export type OsmMonthdayRange =
  | {
      kind: "months";
      year?: number;
      from: OsmMonth;
      to?: OsmMonth;
    }
  | {
      kind: "dates";
      from: OsmDateEndpoint;
      fromOffset?: OsmDateOffset;
      to?: OsmDateEndpoint;
      toOffset?: OsmDateOffset;
      openEnd?: boolean;
    };

export interface OsmWeekRange {
  from: number;
  to?: number;
  step?: number;
}

export type OsmWeekdaySelectorItem =
  | {
      kind: "weekday";
      from: OsmWeekday;
      to?: OsmWeekday;
      nth?: OsmNthEntry[];
      dayOffset?: number;
    }
  | {
      kind: "holiday";
      holiday: OsmHoliday;
      dayOffset?: number;
      /**
       * When true, separated from the following weekday selector by a space (logical AND,
       * e.g. `SH Mo-Fr`) instead of a comma (logical OR, e.g. `PH,Su`).
       */
      andWithNext?: boolean;
    };

export type OsmTimePoint =
  | {
      kind: "clock";
      /** 0..48 (extended hours past midnight, e.g. 26:00 = 02:00 next day) */
      hours: number;
      /** 0..59 */
      minutes: number;
    }
  | {
      kind: "variable";
      event: OsmSolarEvent;
      /** Signed offset in minutes, e.g. +60 -> (sunrise+01:00), -30 -> (sunset-00:30) */
      offsetMinutes?: number;
    };

export interface OsmTimeSelector {
  from: OsmTimePoint;
  to?: OsmTimePoint;
  openEnd?: boolean;
  /** Periodic interval in minutes, e.g. 30 -> /30 or 90 -> /01:30 */
  intervalMinutes?: number;
}

export interface OsmOpeningHoursRule {
  separator: OsmRuleSeparator;
  is24_7: boolean;
  rangeComment?: string;
  years: OsmYearRange[];
  months: OsmMonthdayRange[];
  weeks: OsmWeekRange[];
  colonAfterWideRange?: boolean;
  weekdays: OsmWeekdaySelectorItem[];
  times: OsmTimeSelector[];
  modifier?: OsmRuleModifier;
  comment?: string;
}

export interface OsmOpeningHoursDocument {
  rules: OsmOpeningHoursRule[];
}

export type OsmOpeningHoursParseResult =
  | {
      ok: true;
      document: OsmOpeningHoursDocument;
      canonical: string;
    }
  | {
      ok: false;
      error: string;
      position: number;
    };

const WEEKDAY_MAP: ReadonlyMap<string, OsmWeekday> = new Map(
  OSM_WEEKDAYS.map((w) => [w.toLowerCase(), w]),
);

const MONTH_MAP: ReadonlyMap<string, OsmMonth> = new Map(
  OSM_MONTHS.map((m) => [m.toLowerCase(), m]),
);

const SOLAR_MAP: ReadonlyMap<string, OsmSolarEvent> = new Map(
  OSM_SOLAR_EVENTS.map((s) => [s.toLowerCase(), s]),
);

const MODIFIER_MAP: ReadonlyMap<string, OsmRuleModifier> = new Map(
  OSM_RULE_MODIFIERS.map((m) => [m.toLowerCase(), m]),
);

class ParseError extends Error {
  readonly position: number;

  constructor(message: string, position: number) {
    super(message);
    this.name = "ParseError";
    this.position = position;
  }
}

class Parser {
  private readonly input: string;
  private pos = 0;

  constructor(input: string) {
    this.input = input;
  }

  get position(): number {
    return this.pos;
  }

  isAtEnd(): boolean {
    return this.pos >= this.input.length;
  }

  skipWhitespace(): void {
    while (this.pos < this.input.length) {
      const ch = this.input[this.pos];
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        this.pos++;
      } else {
        break;
      }
    }
  }

  peek(length = 1): string {
    return this.input.slice(this.pos, this.pos + length);
  }

  matchChar(ch: string): boolean {
    this.skipWhitespace();
    if (this.input[this.pos] === ch) {
      this.pos++;
      return true;
    }
    return false;
  }

  matchLiteral(literal: string): boolean {
    this.skipWhitespace();
    if (this.input.startsWith(literal, this.pos)) {
      this.pos += literal.length;
      return true;
    }
    return false;
  }

  private readWord(): string | null {
    this.skipWhitespace();
    const start = this.pos;
    while (this.pos < this.input.length && /[A-Za-z]/.test(this.input.charAt(this.pos))) {
      this.pos++;
    }
    return this.pos > start ? this.input.slice(start, this.pos) : null;
  }

  private peekWord(): { word: string; nextPos: number } | null {
    let p = this.pos;
    while (p < this.input.length && /\s/.test(this.input.charAt(p))) p++;
    const start = p;
    while (p < this.input.length && /[A-Za-z]/.test(this.input.charAt(p))) p++;
    if (p === start) return null;
    return { word: this.input.slice(start, p), nextPos: p };
  }

  private readUnsignedInt(): { value: number; digits: number; start: number } | null {
    this.skipWhitespace();
    const start = this.pos;
    while (this.pos < this.input.length && /[0-9]/.test(this.input.charAt(this.pos))) {
      this.pos++;
    }
    if (this.pos === start) return null;
    const raw = this.input.slice(start, this.pos);
    return { value: Number.parseInt(raw, 10), digits: raw.length, start };
  }

  parseDocument(): OsmOpeningHoursDocument {
    this.skipWhitespace();
    if (this.isAtEnd()) {
      throw new ParseError("Opening hours must not be empty", 0);
    }

    const rules: OsmOpeningHoursRule[] = [];
    let separator: OsmRuleSeparator = ";";

    while (!this.isAtEnd()) {
      const rule = this.parseRule(separator);
      rules.push(rule);
      this.skipWhitespace();
      if (this.isAtEnd()) break;

      if (this.matchLiteral("||")) {
        separator = "||";
      } else if (this.matchChar(";")) {
        separator = ";";
      } else if (this.matchChar(",")) {
        separator = ",";
      } else {
        throw new ParseError(
          `Expected rule separator (';', ',', or '||') near '${this.input.slice(this.pos, this.pos + 12)}'`,
          this.pos,
        );
      }

      this.skipWhitespace();
      if (this.isAtEnd()) {
        throw new ParseError("Trailing rule separator is not allowed", this.pos);
      }
    }

    return { rules };
  }

  private parseRule(separator: OsmRuleSeparator): OsmOpeningHoursRule {
    this.skipWhitespace();
    const ruleStart = this.pos;

    const rule: OsmOpeningHoursRule = {
      separator,
      is24_7: false,
      years: [],
      months: [],
      weeks: [],
      weekdays: [],
      times: [],
    };

    // Optional wide-range comment before selectors: `"comment": ...`
    const savedBeforeComment = this.pos;
    if (this.input[this.pos] === '"') {
      const text = this.parseCommentString();
      this.skipWhitespace();
      if (this.matchChar(":")) {
        rule.rangeComment = text;
      } else {
        // Rewind: this is a rule-level comment at the end of an empty selector rule
        this.pos = savedBeforeComment;
      }
    }

    this.skipWhitespace();
    if (this.input.startsWith("24/7", this.pos)) {
      const after = this.input[this.pos + 4];
      if (!after || /[\s;,|"]/.test(after)) {
        this.pos += 4;
        rule.is24_7 = true;
        this.parseOptionalModifierAndComment(rule);
        return rule;
      }
    }

    // 1. Optional year selector(s)
    this.parseYearSelectors(rule);

    // 2. Optional monthday selector(s)
    this.parseMonthdaySelectors(rule);

    // 3. Optional week selector(s)
    this.parseWeekSelectors(rule);

    // Optional `:` after wide-range selectors
    if (rule.years.length > 0 || rule.months.length > 0 || rule.weeks.length > 0) {
      if (this.matchChar(":")) {
        rule.colonAfterWideRange = true;
      }
    }

    // 4. Optional weekday / holiday selector(s)
    this.parseWeekdaySelectors(rule);

    // 5. Optional time selector(s)
    this.parseTimeSelectors(rule);

    // 6. Optional rule modifier & comment
    this.parseOptionalModifierAndComment(rule);

    const hasAnyContent =
      rule.is24_7 ||
      rule.rangeComment !== undefined ||
      rule.years.length > 0 ||
      rule.months.length > 0 ||
      rule.weeks.length > 0 ||
      rule.weekdays.length > 0 ||
      rule.times.length > 0 ||
      rule.modifier !== undefined ||
      rule.comment !== undefined;

    if (!hasAnyContent) {
      throw new ParseError(
        `Unexpected token near '${this.input.slice(ruleStart, ruleStart + 16)}'`,
        ruleStart,
      );
    }

    return rule;
  }

  private parseCommentString(): string {
    this.skipWhitespace();
    if (this.input[this.pos] !== '"') {
      throw new ParseError("Expected '\"' to start comment", this.pos);
    }
    const start = this.pos;
    this.pos++; // skip opening quote
    let result = "";
    while (this.pos < this.input.length) {
      const ch = this.input.charAt(this.pos);
      if (ch === "\\") {
        this.pos++;
        if (this.pos >= this.input.length) {
          throw new ParseError("Unterminated escape in comment", start);
        }
        result += this.input.charAt(this.pos);
        this.pos++;
        continue;
      }
      if (ch === '"') {
        this.pos++;
        return result;
      }
      result += ch;
      this.pos++;
    }
    throw new ParseError("Unterminated comment string", start);
  }

  private parseYearSelectors(rule: OsmOpeningHoursRule): void {
    while (true) {
      const saved = this.pos;
      const yr = this.tryParseYearRange();
      if (!yr) {
        this.pos = saved;
        break;
      }
      rule.years.push(yr);
      const beforeComma = this.pos;
      if (this.matchChar(",")) {
        const nextSaved = this.pos;
        const nextYr = this.tryParseYearRange();
        this.pos = nextSaved;
        if (!nextYr) {
          this.pos = beforeComma;
          break;
        }
      } else {
        break;
      }
    }
  }

  private tryParseYearRange(): OsmYearRange | null {
    const startPos = this.pos;
    const first = this.readUnsignedInt();
    if (first?.digits !== 4 || first.value <= 1900) {
      return null;
    }

    // Check if this 4-digit year is immediately followed by a month or `easter`
    // (which makes it part of a `<monthday_range>` like `2025 Jan 01` or `2025 easter`).
    const nextWord = this.peekWord();
    if (nextWord) {
      const lower = nextWord.word.toLowerCase();
      if (MONTH_MAP.has(lower) || lower === "easter") {
        return null;
      }
    }

    // Also reject if followed by `:` when it's actually a time, though 4 digits has no colon inside.
    const range: OsmYearRange = { from: first.value };

    if (this.matchChar("-")) {
      const second = this.readUnsignedInt();
      if (second?.digits !== 4 || second.value < first.value) {
        throw new ParseError("Invalid end year in year range", startPos);
      }
      range.to = second.value;
      if (this.matchChar("/")) {
        const step = this.readUnsignedInt();
        if (!step || step.value < 1) {
          throw new ParseError("Invalid step in year range", this.pos);
        }
        range.step = step.value;
      }
    } else if (this.matchChar("+")) {
      range.openEnd = true;
    } else if (this.matchChar("/")) {
      const step = this.readUnsignedInt();
      if (!step || step.value < 1) {
        throw new ParseError("Invalid step in year range", this.pos);
      }
      range.step = step.value;
    }

    return range;
  }

  private parseMonthdaySelectors(rule: OsmOpeningHoursRule): void {
    while (true) {
      const saved = this.pos;
      const md = this.tryParseMonthdayRange();
      if (!md) {
        this.pos = saved;
        break;
      }
      rule.months.push(md);
      const beforeComma = this.pos;
      if (this.matchChar(",")) {
        const nextSaved = this.pos;
        const nextMd = this.tryParseMonthdayRange();
        this.pos = nextSaved;
        if (!nextMd) {
          this.pos = beforeComma;
          break;
        }
      } else {
        break;
      }
    }
  }

  private tryParseMonthdayRange(): OsmMonthdayRange | null {
    this.skipWhitespace();

    // Optional 4-digit year before month or easter
    let leadingYear: number | undefined;
    const savedBeforeYear = this.pos;
    const maybeYear = this.readUnsignedInt();
    if (maybeYear?.digits === 4 && maybeYear.value > 1900) {
      leadingYear = maybeYear.value;
    } else {
      this.pos = savedBeforeYear;
    }

    const wordInfo = this.peekWord();
    if (!wordInfo) return null;
    const lowerWord = wordInfo.word.toLowerCase();

    if (lowerWord === "easter") {
      this.readWord(); // consume 'easter'
      const from: OsmDateEndpoint = {
        kind: "easter",
        ...(leadingYear !== undefined ? { year: leadingYear } : {}),
      };
      const fromOffset = this.tryParseDateOffset();
      return this.finishDateRange(from, fromOffset);
    }

    const month = MONTH_MAP.get(lowerWord);
    if (!month) {
      return null;
    }
    this.readWord(); // consume month name

    // Check if followed by a weekday with `[nth]`, e.g. `May Su[1]` or `May Su[-1]`
    const afterMonthPos = this.pos;
    const maybeWdayWord = this.peekWord();
    if (maybeWdayWord) {
      const wday = WEEKDAY_MAP.get(maybeWdayWord.word.toLowerCase());
      if (wday) {
        this.readWord();
        if (this.matchChar("[")) {
          const nth = this.parseSingleNthValue();
          if (!this.matchChar("]")) {
            throw new ParseError("Expected ']' after nth weekday in month", this.pos);
          }
          const from: OsmDateEndpoint = {
            kind: "nthWeekday",
            ...(leadingYear !== undefined ? { year: leadingYear } : {}),
            month,
            weekday: wday,
            nth,
          };
          const fromOffset = this.tryParseDateOffset();
          return this.finishDateRange(from, fromOffset);
        }
        // Not `wday[nth]` -> rewind to after month name (it's a weekday selector after a month!)
        this.pos = afterMonthPos;
      }
    }

    // Check if followed by a day number (1..31), making it a calendar date
    // Must not be a time `HH:MM` or 4-digit year!
    const beforeDayPos = this.pos;
    const maybeDay = this.readUnsignedInt();
    if (maybeDay) {
      this.skipWhitespace();
      // If followed by `:`, this number is the hour of a time selector (e.g. `Jan 08:00-16:00`)!
      if (this.input[this.pos] === ":" || maybeDay.digits > 2) {
        this.pos = beforeDayPos;
      } else {
        if (maybeDay.value < 1 || maybeDay.value > 31) {
          throw new ParseError(`Invalid day of month: ${maybeDay.value}`, maybeDay.start);
        }
        const from: OsmDateEndpoint = {
          kind: "calendar",
          ...(leadingYear !== undefined ? { year: leadingYear } : {}),
          month,
          day: maybeDay.value,
        };
        const fromOffset = this.tryParseDateOffset();
        return this.finishDateRange(from, fromOffset);
      }
    } else {
      this.pos = beforeDayPos;
    }

    // Otherwise it's a month or month range: `[year] Jan` or `[year] Jan-Mar`
    let toMonth: OsmMonth | undefined;
    const beforeDash = this.pos;
    if (this.matchChar("-")) {
      const endWord = this.readWord();
      const parsedEnd = endWord ? MONTH_MAP.get(endWord.toLowerCase()) : undefined;
      if (!parsedEnd) {
        throw new ParseError("Expected month name after '-' in month range", beforeDash);
      }
      toMonth = parsedEnd;
    }

    return {
      kind: "months",
      ...(leadingYear !== undefined ? { year: leadingYear } : {}),
      from: month,
      ...(toMonth ? { to: toMonth } : {}),
    };
  }

  private finishDateRange(
    from: OsmDateEndpoint,
    fromOffset: OsmDateOffset | undefined,
  ): OsmMonthdayRange {
    if (this.matchChar("+")) {
      return {
        kind: "dates",
        from,
        ...(fromOffset ? { fromOffset } : {}),
        openEnd: true,
      };
    }

    const beforeDash = this.pos;
    if (this.matchChar("-")) {
      // Could be `-<daynum>` (e.g. `May 01-10`) or `-<full date_to>` (e.g. `May 01-May 10`, `easter-easter +1 day`)
      const afterDash = this.pos;
      const maybeShortDay = this.readUnsignedInt();
      if (maybeShortDay && maybeShortDay.digits <= 2 && from.kind === "calendar") {
        // Ensure not followed by a month name (which wouldn't happen for 2 digits anyway)
        if (maybeShortDay.value < 1 || maybeShortDay.value > 31) {
          throw new ParseError(`Invalid day of month: ${maybeShortDay.value}`, maybeShortDay.start);
        }
        const to: OsmDateEndpoint = {
          kind: "calendar",
          month: from.month,
          day: maybeShortDay.value,
        };
        const toOffset = this.tryParseDateOffset();
        return {
          kind: "dates",
          from,
          ...(fromOffset ? { fromOffset } : {}),
          to,
          ...(toOffset ? { toOffset } : {}),
        };
      }
      this.pos = afterDash;
      const toEndpoint = this.tryParseDateEndpoint();
      if (!toEndpoint) {
        throw new ParseError("Expected end date after '-' in date range", beforeDash);
      }
      const toOffset = this.tryParseDateOffset();
      return {
        kind: "dates",
        from,
        ...(fromOffset ? { fromOffset } : {}),
        to: toEndpoint,
        ...(toOffset ? { toOffset } : {}),
      };
    }

    return {
      kind: "dates",
      from,
      ...(fromOffset ? { fromOffset } : {}),
    };
  }

  private tryParseDateEndpoint(): OsmDateEndpoint | null {
    const saved = this.pos;
    let year: number | undefined;
    const maybeYear = this.readUnsignedInt();
    if (maybeYear && maybeYear.digits === 4 && maybeYear.value > 1900) {
      year = maybeYear.value;
    } else {
      this.pos = saved;
    }

    const wordInfo = this.peekWord();
    if (!wordInfo) {
      this.pos = saved;
      return null;
    }
    const lower = wordInfo.word.toLowerCase();
    if (lower === "easter") {
      this.readWord();
      return {
        kind: "easter",
        ...(year !== undefined ? { year } : {}),
      };
    }

    const month = MONTH_MAP.get(lower);
    if (!month) {
      this.pos = saved;
      return null;
    }
    this.readWord();

    const maybeWday = this.peekWord();
    if (maybeWday) {
      const wday = WEEKDAY_MAP.get(maybeWday.word.toLowerCase());
      if (wday) {
        const beforeWday = this.pos;
        this.readWord();
        if (this.matchChar("[")) {
          const nth = this.parseSingleNthValue();
          if (!this.matchChar("]")) {
            throw new ParseError("Expected ']' after nth weekday", this.pos);
          }
          return {
            kind: "nthWeekday",
            ...(year !== undefined ? { year } : {}),
            month,
            weekday: wday,
            nth,
          };
        }
        this.pos = beforeWday;
      }
    }

    const dayNum = this.readUnsignedInt();
    if (!dayNum || dayNum.digits > 2 || dayNum.value < 1 || dayNum.value > 31) {
      this.pos = saved;
      return null;
    }
    return {
      kind: "calendar",
      ...(year !== undefined ? { year } : {}),
      month,
      day: dayNum.value,
    };
  }

  private tryParseDateOffset(): OsmDateOffset | undefined {
    let weekdayOffset: OsmDateOffset["weekdayOffset"];
    let dayOffset: number | undefined;

    // Optional `[+|-]<wday>`
    const savedForWday = this.pos;
    this.skipWhitespace();
    if (this.input[this.pos] === "+" || this.input[this.pos] === "-") {
      const positive = this.input[this.pos] === "+";
      this.pos++;
      const wordInfo = this.peekWord();
      const wday = wordInfo ? WEEKDAY_MAP.get(wordInfo.word.toLowerCase()) : undefined;
      if (wday) {
        this.readWord();
        weekdayOffset = { positive, weekday: wday };
      } else {
        this.pos = savedForWday;
      }
    } else {
      this.pos = savedForWday;
    }

    // Optional `[+|-]<n> day[s]`
    const parsedDayOffset = this.tryParseDayOffset();
    if (parsedDayOffset !== undefined) {
      dayOffset = parsedDayOffset;
    }

    if (!weekdayOffset && dayOffset === undefined) {
      return undefined;
    }
    return {
      ...(weekdayOffset ? { weekdayOffset } : {}),
      ...(dayOffset !== undefined ? { dayOffset } : {}),
    };
  }

  private tryParseDayOffset(): number | undefined {
    const saved = this.pos;
    this.skipWhitespace();
    const signChar = this.input[this.pos];
    if (signChar !== "+" && signChar !== "-") {
      return undefined;
    }
    this.pos++;
    const num = this.readUnsignedInt();
    if (!num || num.value < 1) {
      this.pos = saved;
      return undefined;
    }
    const word = this.readWord();
    if (!word || (word.toLowerCase() !== "day" && word.toLowerCase() !== "days")) {
      this.pos = saved;
      return undefined;
    }
    return signChar === "-" ? -num.value : num.value;
  }

  private parseWeekSelectors(rule: OsmOpeningHoursRule): void {
    const wordInfo = this.peekWord();
    if (wordInfo?.word.toLowerCase() !== "week") {
      return;
    }
    this.readWord(); // consume 'week'

    while (true) {
      const wk = this.parseSingleWeekRange();
      rule.weeks.push(wk);
      const beforeComma = this.pos;
      if (this.matchChar(",")) {
        const nextSaved = this.pos;
        const nextInt = this.readUnsignedInt();
        this.pos = nextSaved;
        if (!nextInt) {
          this.pos = beforeComma;
          break;
        }
      } else {
        break;
      }
    }
  }

  private parseSingleWeekRange(): OsmWeekRange {
    const first = this.readUnsignedInt();
    if (!first || first.value < 1 || first.value > 53) {
      throw new ParseError("Expected week number (01..53) after 'week'", this.pos);
    }
    const range: OsmWeekRange = { from: first.value };
    if (this.matchChar("-")) {
      const second = this.readUnsignedInt();
      if (!second || second.value < 1 || second.value > 53) {
        throw new ParseError("Expected end week number (01..53)", this.pos);
      }
      range.to = second.value;
      if (this.matchChar("/")) {
        const step = this.readUnsignedInt();
        if (!step || step.value < 1) {
          throw new ParseError("Expected positive step after '/' in week range", this.pos);
        }
        range.step = step.value;
      }
    }
    return range;
  }

  private parseWeekdaySelectors(rule: OsmOpeningHoursRule): void {
    while (true) {
      const saved = this.pos;
      const item = this.tryParseWeekdaySelectorItem();
      if (!item) {
        this.pos = saved;
        break;
      }
      rule.weekdays.push(item);

      const beforeSep = this.pos;
      if (this.matchChar(",")) {
        const lookahead = this.pos;
        const nextItem = this.tryParseWeekdaySelectorItem();
        this.pos = lookahead;
        if (!nextItem) {
          // This comma separates rules (e.g. `Mo-Fr 09:00-17:00, Sa ...`), not weekday items!
          this.pos = beforeSep;
          break;
        }
      } else if (item.kind === "holiday") {
        // A holiday selector (`PH` or `SH`) can be followed by space (AND) + weekday selector!
        const lookahead = this.pos;
        const nextItem = this.tryParseWeekdaySelectorItem();
        this.pos = lookahead;
        if (nextItem) {
          item.andWithNext = true;
        } else {
          break;
        }
      } else {
        break;
      }
    }
  }

  private tryParseWeekdaySelectorItem(): OsmWeekdaySelectorItem | null {
    const wordInfo = this.peekWord();
    if (!wordInfo) return null;
    const upper = wordInfo.word.toUpperCase();
    const lower = wordInfo.word.toLowerCase();

    if (upper === "PH" || upper === "SH") {
      this.readWord();
      const holiday = upper as OsmHoliday;
      const dayOffset = holiday === "PH" ? this.tryParseDayOffset() : undefined;
      return {
        kind: "holiday",
        holiday,
        ...(dayOffset !== undefined ? { dayOffset } : {}),
      };
    }

    const fromWday = WEEKDAY_MAP.get(lower);
    if (!fromWday) return null;
    this.readWord();

    if (this.matchChar("-")) {
      const endWord = this.readWord();
      const toWday = endWord ? WEEKDAY_MAP.get(endWord.toLowerCase()) : undefined;
      if (!toWday) {
        throw new ParseError("Expected weekday after '-' in weekday range", this.pos);
      }
      return {
        kind: "weekday",
        from: fromWday,
        to: toWday,
      };
    }

    let nth: OsmNthEntry[] | undefined;
    if (this.matchChar("[")) {
      nth = [];
      while (true) {
        const entry = this.parseNthEntry();
        nth.push(entry);
        if (!this.matchChar(",")) break;
      }
      if (!this.matchChar("]")) {
        throw new ParseError("Expected ']' after nth weekday selector", this.pos);
      }
    }

    const dayOffset = this.tryParseDayOffset();

    return {
      kind: "weekday",
      from: fromWday,
      ...(nth ? { nth } : {}),
      ...(dayOffset !== undefined ? { dayOffset } : {}),
    };
  }

  private parseNthEntry(): OsmNthEntry {
    const from = this.parseSingleNthValue();
    if (this.matchChar("-")) {
      const to = this.parseSingleNthValue();
      if (from < 0 || to < 0 || to < from) {
        throw new ParseError("Invalid nth range in weekday selector", this.pos);
      }
      return { from, to };
    }
    return { from };
  }

  private parseSingleNthValue(): OsmNthValue {
    this.skipWhitespace();
    let negative = false;
    if (this.input[this.pos] === "-") {
      negative = true;
      this.pos++;
    }
    const num = this.readUnsignedInt();
    if (!num || num.value < 1 || num.value > 5) {
      throw new ParseError("Expected nth occurrence between 1 and 5 (or -1 to -5)", this.pos);
    }
    return (negative ? -num.value : num.value) as OsmNthValue;
  }

  private parseTimeSelectors(rule: OsmOpeningHoursRule): void {
    while (true) {
      const saved = this.pos;
      const ts = this.tryParseTimeSelector();
      if (!ts) {
        this.pos = saved;
        break;
      }
      rule.times.push(ts);

      const beforeComma = this.pos;
      if (this.matchChar(",")) {
        const lookahead = this.pos;
        const nextTs = this.tryParseTimeSelector();
        this.pos = lookahead;
        if (!nextTs) {
          this.pos = beforeComma;
          break;
        }
      } else {
        break;
      }
    }
  }

  private tryParseTimeSelector(): OsmTimeSelector | null {
    const from = this.tryParseTimePoint(false);
    if (!from) return null;

    if (this.matchChar("-")) {
      const to = this.tryParseTimePoint(true);
      if (!to) {
        throw new ParseError("Expected end time after '-' in time range", this.pos);
      }
      if (this.matchChar("+")) {
        return { from, to, openEnd: true };
      }
      if (this.matchChar("/")) {
        const intervalMinutes = this.parseIntervalMinutes();
        return { from, to, intervalMinutes };
      }
      return { from, to };
    }

    if (this.matchChar("+")) {
      return { from, openEnd: true };
    }

    return { from };
  }

  private tryParseTimePoint(allowExtendedHours: boolean): OsmTimePoint | null {
    this.skipWhitespace();
    const saved = this.pos;

    // 1. Parenthesized variable time with offset: `(sunrise+01:00)` or `(sunset-00:30)`
    if (this.matchChar("(")) {
      const word = this.readWord();
      const event = word ? SOLAR_MAP.get(word.toLowerCase()) : undefined;
      if (!event) {
        throw new ParseError("Expected solar event (dawn, sunrise, sunset, dusk) after '('", saved);
      }
      this.skipWhitespace();
      const signChar = this.input[this.pos];
      if (signChar !== "+" && signChar !== "-") {
        throw new ParseError("Expected '+' or '-' offset after solar event inside '('", this.pos);
      }
      this.pos++;
      const offsetClock = this.parseHourMinute(false);
      if (!this.matchChar(")")) {
        throw new ParseError("Expected ')' after solar event offset", this.pos);
      }
      const totalMinutes = offsetClock.hours * 60 + offsetClock.minutes;
      return {
        kind: "variable",
        event,
        offsetMinutes: signChar === "-" ? -totalMinutes : totalMinutes,
      };
    }

    // 2. Unparenthesized variable time: `dawn`, `sunrise`, `sunset`, `dusk`
    const wordInfo = this.peekWord();
    if (wordInfo) {
      const event = SOLAR_MAP.get(wordInfo.word.toLowerCase());
      if (event) {
        this.readWord();
        return { kind: "variable", event };
      }
    }

    // 3. Clock time `HH:MM`
    const clock = this.tryParseHourMinute(allowExtendedHours);
    if (!clock) {
      this.pos = saved;
      return null;
    }
    return {
      kind: "clock",
      hours: clock.hours,
      minutes: clock.minutes,
    };
  }

  private parseHourMinute(allowExtendedHours: boolean): { hours: number; minutes: number } {
    const parsed = this.tryParseHourMinute(allowExtendedHours);
    if (!parsed) {
      throw new ParseError("Expected HH:MM time", this.pos);
    }
    return parsed;
  }

  private tryParseHourMinute(
    allowExtendedHours: boolean,
  ): { hours: number; minutes: number } | null {
    const saved = this.pos;
    const h = this.readUnsignedInt();
    if (!h || h.digits > 2) {
      this.pos = saved;
      return null;
    }
    // Must be immediately followed by ':' (no whitespace inside HH:MM)
    if (this.input[this.pos] !== ":") {
      this.pos = saved;
      return null;
    }
    this.pos++; // consume ':'
    if (this.pos >= this.input.length || !/[0-9]/.test(this.input.charAt(this.pos))) {
      throw new ParseError("Expected minutes after ':' in time", this.pos);
    }
    const m = this.readUnsignedInt();
    if (m?.digits !== 2 || m.value > 59) {
      throw new ParseError("Minutes in time must be two digits between 00 and 59", saved);
    }
    const maxHour = allowExtendedHours ? 48 : 24;
    if (h.value > maxHour || (h.value === maxHour && m.value > 0)) {
      throw new ParseError(`Hours in time must not exceed ${maxHour}:00`, saved);
    }
    return { hours: h.value, minutes: m.value };
  }

  private parseIntervalMinutes(): number {
    const saved = this.pos;
    const first = this.readUnsignedInt();
    if (!first) {
      throw new ParseError("Expected interval after '/'", saved);
    }
    if (this.input[this.pos] === ":") {
      this.pos++;
      const m = this.readUnsignedInt();
      if (m?.digits !== 2 || m.value > 59) {
        throw new ParseError("Invalid HH:MM interval after '/'", saved);
      }
      const total = first.value * 60 + m.value;
      if (total < 1) {
        throw new ParseError("Interval must be at least 1 minute", saved);
      }
      return total;
    }
    if (first.value < 1) {
      throw new ParseError("Interval must be at least 1 minute", saved);
    }
    return first.value;
  }

  private parseOptionalModifierAndComment(rule: OsmOpeningHoursRule): void {
    const wordInfo = this.peekWord();
    if (wordInfo) {
      const mod = MODIFIER_MAP.get(wordInfo.word.toLowerCase());
      if (mod) {
        this.readWord();
        rule.modifier = mod;
      }
    }
    this.skipWhitespace();
    if (this.input[this.pos] === '"') {
      rule.comment = this.parseCommentString();
    }
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function escapeComment(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function serializeYearRange(yr: OsmYearRange): string {
  let out = String(yr.from);
  if (yr.to !== undefined) {
    out += `-${yr.to}`;
    if (yr.step !== undefined && yr.step > 1) {
      out += `/${yr.step}`;
    }
  } else if (yr.openEnd) {
    out += "+";
  } else if (yr.step !== undefined && yr.step > 1) {
    out += `/${yr.step}`;
  }
  return out;
}

function serializeDateOffset(offset?: OsmDateOffset): string {
  if (!offset) return "";
  const parts: string[] = [];
  if (offset.weekdayOffset) {
    const sign = offset.weekdayOffset.positive ? "+" : "-";
    parts.push(`${sign}${offset.weekdayOffset.weekday}`);
  }
  if (offset.dayOffset !== undefined && offset.dayOffset !== 0) {
    const sign = offset.dayOffset > 0 ? "+" : "-";
    const abs = Math.abs(offset.dayOffset);
    parts.push(`${sign}${abs} ${abs === 1 ? "day" : "days"}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function serializeDateEndpoint(ep: OsmDateEndpoint): string {
  const yr = ep.year !== undefined ? `${ep.year} ` : "";
  switch (ep.kind) {
    case "easter":
      return `${yr}easter`;
    case "nthWeekday":
      return `${yr}${ep.month} ${ep.weekday}[${ep.nth}]`;
    case "calendar":
      return `${yr}${ep.month} ${pad2(ep.day)}`;
  }
}

function serializeMonthdayRange(md: OsmMonthdayRange): string {
  if (md.kind === "months") {
    const yr = md.year !== undefined ? `${md.year} ` : "";
    return `${yr}${md.from}${md.to ? `-${md.to}` : ""}`;
  }

  let out = serializeDateEndpoint(md.from) + serializeDateOffset(md.fromOffset);
  if (md.openEnd) {
    out += "+";
  } else if (md.to) {
    const canShortenSameMonth =
      md.from.kind === "calendar" &&
      md.to.kind === "calendar" &&
      !md.fromOffset &&
      md.to.year === undefined &&
      md.from.month === md.to.month;

    if (canShortenSameMonth && md.to.kind === "calendar") {
      out += `-${pad2(md.to.day)}${serializeDateOffset(md.toOffset)}`;
    } else {
      out += `-${serializeDateEndpoint(md.to)}${serializeDateOffset(md.toOffset)}`;
    }
  }
  return out;
}

function serializeWeekRange(wk: OsmWeekRange): string {
  let out = pad2(wk.from);
  if (wk.to !== undefined) {
    out += `-${pad2(wk.to)}`;
    if (wk.step !== undefined && wk.step > 1) {
      out += `/${wk.step}`;
    }
  }
  return out;
}

function serializeDayOffset(dayOffset?: number): string {
  if (dayOffset === undefined || dayOffset === 0) return "";
  const sign = dayOffset > 0 ? "+" : "-";
  const abs = Math.abs(dayOffset);
  return ` ${sign}${abs} ${abs === 1 ? "day" : "days"}`;
}

function serializeWeekdaySelectors(items: OsmWeekdaySelectorItem[]): string {
  if (items.length === 0) return "";
  let out = "";
  let prev: OsmWeekdaySelectorItem | undefined;
  for (const item of items) {
    if (prev) {
      const useSpace = prev.kind === "holiday" && prev.andWithNext;
      out += useSpace ? " " : ",";
    }
    prev = item;
    if (item.kind === "holiday") {
      out += item.holiday;
      if (item.holiday === "PH") {
        out += serializeDayOffset(item.dayOffset);
      }
    } else {
      out += item.from;
      if (item.to) {
        out += `-${item.to}`;
      } else {
        if (item.nth && item.nth.length > 0) {
          const entries = item.nth
            .map((e) => (e.to !== undefined ? `${e.from}-${e.to}` : `${e.from}`))
            .join(",");
          out += `[${entries}]`;
        }
        out += serializeDayOffset(item.dayOffset);
      }
    }
  }
  return out;
}

function serializeTimePoint(tp: OsmTimePoint): string {
  if (tp.kind === "clock") {
    return `${pad2(tp.hours)}:${pad2(tp.minutes)}`;
  }
  if (!tp.offsetMinutes) {
    return tp.event;
  }
  const sign = tp.offsetMinutes > 0 ? "+" : "-";
  const abs = Math.abs(tp.offsetMinutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `(${tp.event}${sign}${pad2(h)}:${pad2(m)})`;
}

function serializeTimeSelector(ts: OsmTimeSelector): string {
  let out = serializeTimePoint(ts.from);
  if (ts.to) {
    out += `-${serializeTimePoint(ts.to)}`;
    if (ts.openEnd) {
      out += "+";
    } else if (ts.intervalMinutes !== undefined && ts.intervalMinutes > 0) {
      if (ts.intervalMinutes < 60) {
        out += `/${ts.intervalMinutes}`;
      } else {
        const h = Math.floor(ts.intervalMinutes / 60);
        const m = ts.intervalMinutes % 60;
        out += `/${pad2(h)}:${pad2(m)}`;
      }
    }
  } else if (ts.openEnd) {
    out += "+";
  }
  return out;
}

export function serializeOsmOpeningHoursRule(rule: OsmOpeningHoursRule): string {
  const parts: string[] = [];

  if (rule.rangeComment !== undefined) {
    parts.push(`"${escapeComment(rule.rangeComment)}":`);
  }

  if (rule.is24_7) {
    parts.push("24/7");
    if (rule.modifier) parts.push(rule.modifier);
    if (rule.comment !== undefined) parts.push(`"${escapeComment(rule.comment)}"`);
    return parts.join(" ");
  }

  const wideParts: string[] = [];
  if (rule.years.length > 0) {
    wideParts.push(rule.years.map(serializeYearRange).join(","));
  }
  if (rule.months.length > 0) {
    wideParts.push(rule.months.map(serializeMonthdayRange).join(","));
  }
  if (rule.weeks.length > 0) {
    wideParts.push(`week ${rule.weeks.map(serializeWeekRange).join(",")}`);
  }

  if (wideParts.length > 0) {
    const wideStr = wideParts.join(" ");
    parts.push(rule.colonAfterWideRange ? `${wideStr}:` : wideStr);
  }

  const weekdayStr = serializeWeekdaySelectors(rule.weekdays);
  if (weekdayStr) {
    parts.push(weekdayStr);
  }

  if (rule.times.length > 0) {
    parts.push(rule.times.map(serializeTimeSelector).join(","));
  }

  if (rule.modifier) {
    parts.push(rule.modifier);
  }

  if (rule.comment !== undefined) {
    parts.push(`"${escapeComment(rule.comment)}"`);
  }

  return parts.join(" ");
}

export function serializeOsmOpeningHours(doc: OsmOpeningHoursDocument): string {
  if (doc.rules.length === 0) return "";
  let out = "";
  for (const rule of doc.rules) {
    const body = serializeOsmOpeningHoursRule(rule);
    if (!body) continue;
    if (out === "") {
      out = body;
    } else {
      const sep = rule.separator === "||" ? " || " : rule.separator === "," ? ", " : "; ";
      out += `${sep}${body}`;
    }
  }
  return out;
}

export function parseOsmOpeningHours(input: string): OsmOpeningHoursParseResult {
  try {
    const parser = new Parser(input);
    const document = parser.parseDocument();
    const canonical = serializeOsmOpeningHours(document);
    if (!canonical) {
      return {
        ok: false,
        error: "Opening hours must not be empty",
        position: 0,
      };
    }
    return {
      ok: true,
      document,
      canonical,
    };
  } catch (err) {
    if (err instanceof ParseError) {
      return {
        ok: false,
        error: err.message,
        position: err.position,
      };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      position: 0,
    };
  }
}

/**
 * If a rule's weekday selectors consist purely of simple weekdays/ranges and
 * simple `PH` / `SH` (no `nth`, no `dayOffset`, no wrap-around ranges like `Fr-Mo`),
 * returns the expanded set of selected days & holidays so the visual editor can
 * render interactive toggle chips while also supporting complex constraints.
 */
export interface SimpleWeekdaySelection {
  weekdays: OsmWeekday[];
  includePH: boolean;
  includeSH: boolean;
  shAndMode: boolean;
}

export function extractSimpleWeekdaySelection(
  items: OsmWeekdaySelectorItem[],
): SimpleWeekdaySelection | null {
  const selected = new Set<OsmWeekday>();
  let includePH = false;
  let includeSH = false;
  let shAndMode = false;

  for (const item of items) {
    if (item.kind === "holiday") {
      if (item.dayOffset !== undefined && item.dayOffset !== 0) {
        return null;
      }
      if (item.holiday === "PH") {
        if (item.andWithNext) return null;
        includePH = true;
      } else {
        includeSH = true;
        if (item.andWithNext) shAndMode = true;
      }
      continue;
    }

    if (
      (item.nth && item.nth.length > 0) ||
      (item.dayOffset !== undefined && item.dayOffset !== 0)
    ) {
      return null;
    }

    if (!item.to) {
      selected.add(item.from);
    } else {
      const startIdx = OSM_WEEKDAYS.indexOf(item.from);
      const endIdx = OSM_WEEKDAYS.indexOf(item.to);
      if (endIdx < startIdx) {
        // Wrap-around weekday range (e.g. Fr-Mo) -> preserve in advanced mode
        return null;
      }
      for (const day of OSM_WEEKDAYS.slice(startIdx, endIdx + 1)) {
        selected.add(day);
      }
    }
  }

  return {
    weekdays: OSM_WEEKDAYS.filter((w) => selected.has(w)),
    includePH,
    includeSH,
    shAndMode,
  };
}

/**
 * Compacts a set of selected weekdays + optional PH/SH into canonical OSM
 * `OsmWeekdaySelectorItem[]` (e.g., `["Mo","Tu","We","Th","Fr"]` -> `Mo-Fr`,
 * two consecutive days `["Mo","Tu"]` -> `Mo,Tu` or `Mo-Tu` -> `Mo-Tu`).
 */
export function buildSimpleWeekdaySelectors(
  selection: SimpleWeekdaySelection,
): OsmWeekdaySelectorItem[] {
  const ordered = OSM_WEEKDAYS.filter((w) => selection.weekdays.includes(w));
  const weekdayItems: OsmWeekdaySelectorItem[] = [];

  let i = 0;
  while (i < ordered.length) {
    const startDay = ordered[i];
    if (!startDay) break;
    let endPos = i;
    while (endPos + 1 < ordered.length) {
      const currentDay = ordered[endPos];
      const nextDay = ordered[endPos + 1];
      if (
        currentDay &&
        nextDay &&
        OSM_WEEKDAYS.indexOf(nextDay) === OSM_WEEKDAYS.indexOf(currentDay) + 1
      ) {
        endPos++;
      } else {
        break;
      }
    }
    const endDay = ordered[endPos] ?? startDay;
    const spanLength = endPos - i + 1;
    if (spanLength >= 2) {
      weekdayItems.push({
        kind: "weekday",
        from: startDay,
        to: endDay,
      });
    } else {
      weekdayItems.push({
        kind: "weekday",
        from: startDay,
      });
    }
    i = endPos + 1;
  }

  const result: OsmWeekdaySelectorItem[] = [];

  if (selection.includeSH && selection.shAndMode && weekdayItems.length > 0) {
    result.push({
      kind: "holiday",
      holiday: "SH",
      andWithNext: true,
    });
  }

  result.push(...weekdayItems);

  if (selection.includeSH && (!selection.shAndMode || weekdayItems.length === 0)) {
    result.push({
      kind: "holiday",
      holiday: "SH",
    });
  }

  if (selection.includePH) {
    result.push({
      kind: "holiday",
      holiday: "PH",
    });
  }

  return result;
}

export function createDefaultOpeningHoursRule(
  separator: OsmRuleSeparator = ";",
): OsmOpeningHoursRule {
  return {
    separator,
    is24_7: false,
    years: [],
    months: [],
    weeks: [],
    weekdays: [
      {
        kind: "weekday",
        from: "Mo",
        to: "Fr",
      },
    ],
    times: [
      {
        from: { kind: "clock", hours: 9, minutes: 0 },
        to: { kind: "clock", hours: 17, minutes: 0 },
      },
    ],
  };
}
