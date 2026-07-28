export interface LabeledSearchResult {
  id: string;
  relevant: boolean;
  /** ID of an earlier result representing the same real-world business. */
  duplicateOf?: string;
}

export interface LabeledSearchCase {
  query: string;
  /** Total relevant places established by the human assessor, including misses. */
  totalRelevant: number;
  results: LabeledSearchResult[];
}

export interface SearchQualityMetrics {
  cases: number;
  precisionAt50: number;
  recallAt50: number;
  meanReciprocalRank: number;
  duplicateRate: number;
}

/** Computes macro-averaged metrics for labeled, production-ordered POI responses. */
export function evaluateSearchQuality(cases: LabeledSearchCase[]): SearchQualityMetrics {
  if (cases.length === 0) {
    return { cases: 0, precisionAt50: 0, recallAt50: 0, meanReciprocalRank: 0, duplicateRate: 0 };
  }

  let precision = 0;
  let recall = 0;
  let reciprocalRank = 0;
  let duplicateRate = 0;
  for (const entry of cases) {
    const results = entry.results.slice(0, 50);
    const relevant = results.filter((result) => result.relevant).length;
    precision += results.length === 0 ? 0 : relevant / results.length;
    recall += entry.totalRelevant === 0 ? 1 : relevant / entry.totalRelevant;
    const firstRelevant = results.findIndex((result) => result.relevant);
    reciprocalRank += firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1);
    duplicateRate +=
      results.length === 0
        ? 0
        : results.filter((result) => Boolean(result.duplicateOf)).length / results.length;
  }

  return {
    cases: cases.length,
    precisionAt50: precision / cases.length,
    recallAt50: recall / cases.length,
    meanReciprocalRank: reciprocalRank / cases.length,
    duplicateRate: duplicateRate / cases.length,
  };
}
