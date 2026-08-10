/**
 * Pre-commit guard: keep the legal pages' "Last updated" date honest.
 *
 * The Privacy Policy and Terms pages each render a hand-set "Last updated: <Month
 * YYYY>" (EN) / "Zuletzt aktualisiert: <Monat JJJJ>" (DE). Two failure modes this
 * guards against:
 *
 *   1. Staleness — a legal content file is staged with changes but its date line
 *      wasn't bumped in the same commit. Uses the staged diff (`git diff --cached`),
 *      which is exactly the pre-commit context and works for direct-to-main commits.
 *      (Skipped gracefully when git/staged info isn't available, e.g. plain CI runs.)
 *   2. Locale drift — the EN and DE copies of a page disagree on the date.
 *
 * Run on demand with `pnpm check-legal-updated`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Page {
  key: string;
  /** Repo-relative paths (matching `git diff --cached --name-only` output). */
  files: { en: string; de: string };
}

const PAGES: Page[] = [
  {
    key: "privacy",
    files: {
      en: "apps/web/src/app/(legal)/privacy/content.en.tsx",
      de: "apps/web/src/app/(legal)/privacy/content.de.tsx",
    },
  },
  {
    key: "terms",
    files: {
      en: "apps/web/src/app/(legal)/terms/content.en.tsx",
      de: "apps/web/src/app/(legal)/terms/content.de.tsx",
    },
  },
];

/** EN format: "June 12, 2026" (month day, year). */
const EN_DATE = /Last updated:\s*([A-Za-zäöüÄÖÜ]+)\s+(\d{1,2}),?\s+(\d{4})/;
/** DE format: "12. Juni 2026" (day. month year). */
const DE_DATE = /Zuletzt aktualisiert:\s*(\d{1,2})\.\s+([A-Za-zäöüÄÖÜ]+)\s+(\d{4})/;

/** A line is a "date line" iff it parses as a valid date in either locale. */
const isDateLine = (line: string) => EN_DATE.test(line) || DE_DATE.test(line);

/** English + German month names → 1-12 (shared spellings like "April" listed once). */
const MONTHS: Record<string, number> = {
  january: 1,
  februar: 2,
  february: 2,
  januar: 1,
  märz: 3,
  march: 3,
  april: 4,
  may: 5,
  mai: 5,
  june: 6,
  juni: 6,
  july: 7,
  juli: 7,
  august: 8,
  september: 9,
  october: 10,
  oktober: 10,
  november: 11,
  december: 12,
  dezember: 12,
};

const problems: string[] = [];

function parseDate(
  text: string,
  label: string,
): { y: number; m: number; d: number; raw: string } | null {
  const en = text.match(EN_DATE);
  const de = text.match(DE_DATE);
  let day: number;
  let monthName: string;
  let year: string;
  if (en) {
    monthName = en[1];
    day = Number(en[2]);
    year = en[3];
  } else if (de) {
    day = Number(de[1]);
    monthName = de[2];
    year = de[3];
  } else {
    problems.push(`${label}: no "Last updated: <day Month YYYY>" line found`);
    return null;
  }
  const m = MONTHS[monthName.toLowerCase()];
  if (!m) {
    problems.push(`${label}: unrecognized month "${monthName}"`);
    return null;
  }
  return { y: Number(year), m, d: day, raw: `${day} ${monthName} ${year}` };
}

/** Staged file list, or null when git/staged info is unavailable. */
function stagedFiles(): string[] | null {
  try {
    const out = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

function diffTouchesDateLine(diff: string): boolean {
  return diff
    .split("\n")
    .some((line) => (line.startsWith("+") || line.startsWith("-")) && isDateLine(line));
}

function mergeHead(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "MERGE_HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Did the staged result touch a date line relative to either merge parent?
 *
 * A same-day merge can legitimately retain parent one's already-current date
 * while advancing parent two's older legal copy. Checking only `HEAD` rejects
 * that honest resolution, so an active merge also compares the index with
 * `MERGE_HEAD`. Ordinary commits retain the original single-parent behavior.
 */
function dateLineChangedInStaged(file: string): boolean {
  const references: Array<string | null> = [null];
  const secondParent = mergeHead();
  if (secondParent) references.push(secondParent);
  for (const reference of references) {
    try {
      const args = ["diff", "--cached", ...(reference ? [reference] : []), "--", file];
      const diff = execFileSync("git", args, {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      if (diffTouchesDateLine(diff)) return true;
    } catch {
      // Try the remaining parent, if any; a failed Git lookup is not evidence
      // that the legal date changed.
    }
  }
  return false;
}

function main(): void {
  const staged = stagedFiles();

  for (const page of PAGES) {
    const enPath = join(REPO_ROOT, page.files.en);
    const dePath = join(REPO_ROOT, page.files.de);
    if (!existsSync(enPath) || !existsSync(dePath)) {
      problems.push(`${page.key}: content files missing`);
      continue;
    }

    const enDate = parseDate(readFileSync(enPath, "utf8"), page.files.en);
    const deDate = parseDate(readFileSync(dePath, "utf8"), page.files.de);

    // Locale drift: EN and DE must agree on the date.
    if (
      enDate &&
      deDate &&
      (enDate.y !== deDate.y || enDate.m !== deDate.m || enDate.d !== deDate.d)
    ) {
      problems.push(
        `${page.key}: EN and DE "Last updated" disagree (${enDate.raw} vs ${deDate.raw}) — keep both locales in sync.`,
      );
    }

    // Staleness: a staged content change must bump the date line.
    if (staged) {
      for (const rel of [page.files.en, page.files.de]) {
        if (staged.includes(rel) && !dateLineChangedInStaged(rel)) {
          problems.push(
            `${rel} is staged with changes but its "Last updated" date wasn't bumped — update it in the same commit.`,
          );
        }
      }
    }
  }

  if (problems.length) {
    console.error('✖ Legal "Last updated" check failed:');
    for (const p of problems) console.error(`  • ${p}`);
    process.exit(1);
  }

  const note = staged === null ? " (staleness check skipped — no git staged info)" : "";
  console.log(`✓ Legal "Last updated" dates are consistent across locales${note}.`);
}

main();
