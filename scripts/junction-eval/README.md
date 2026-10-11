# Junction evaluation

This evaluator separates source acquisition, route/lane truth, photo relevance,
registration and presentation. Case identifiers describe synthetic public-station
controls, never a user's journey. The audit manifest records 31 raw-OSM/PR-mapper
and 23 deployed-mapper cases; it is provenance, not independently reviewed truth.
Photograph bytes and generated results stay outside Git.

```sh
pnpm -C packages/cli exec tsx ../../scripts/junction-eval/collect.mts --import-audit plans/junction-review-2026-10-11
pnpm junction-eval:validate
pnpm junction-eval:score --split holdout --outputs scripts/junction-eval/results/outputs.json
```

Arguments resolve from the repository root, including when invoked through
`pnpm -C packages/cli`. Absolute paths also work. `validate.mts [manifest]` exits 1 for invalid evidence.
`score.mts` exits 1 when any frozen correctness, coverage or usefulness gate fails;
`--report-only` prints the same failures without a failing exit code. An empty
holdout and reject-all algorithm cannot pass.

The `ReferenceFrame` schema in `oracle.ts` stores site and capture sequence,
revision and SHA-256 hashes, license/dimensions, split and category provenance.
Annotations are independent evidence: selected travel lanes, contiguous sign
spans, original-pixel lane/forbidden polygons, relevance and uncertainty. Certain
truth requires two distinct independent reviewers; names must refer to actual
review records. The calibration is excluded from holdout. Never infer ground
truth from current navigation output, assign fictitious reviewers or lower
precision thresholds to meet coverage targets.

Scoring checks filled polygons against the selected lane masks and forbidden
regions with a 2 CSS-pixel boundary tolerance at 390px. Report abstention and
unscorable frames separately. Source hashes must be checked when restoring the
external raw-response/media package. A new capture invalidates old masks.

Only rights-reviewed, attributed media may be retained in the external QA
package. Preserve source policy, upstream quotas and navigation restrictions.
No provider calls run in normal unit CI. Add independently annotated cases to
the manifest when review is complete; the present manifest intentionally has no
fabricated lane masks or held-out positives.

To render an external acquisition package with current production components and
the module worker:

```sh
pnpm junction-eval:render --cases /absolute/path/to/data/cases.json
python3 -m http.server 8768 --bind 127.0.0.1 --directory scripts/junction-eval/results/browser
```

Each case supplies a neutral ID/region, route geometry, decision point, raw lookup
and optional image metadata. A sibling `<region>-route.json` containing
`{ "body": { "routes": [route] } }` enables the actual banner and `navigationReplay`.
The page exposes `prepare(id)`, `showCases(ids, width, locale, dark, distance, speed)`,
`replay()` and `navigationReplay(id)`. Query `?replay=1` runs a bounded browser
preparation replay and displays measurements; `?case=<id>&locale=de&dark=1` opens
a particular mobile rendering. The harness does not run production network hooks
or a native WebView. Store exact source/worker hashes with outputs.

The frozen strict release gates remain unmet: no independently reviewed holdout
exists, and registration has not demonstrated useful coverage on the expanded
German acquisition. CI validates provenance and exercises the deterministic
oracle; it does not certify the release gates. Reject-all remains a failing result.

See [the method comparison](METHODS.md) for the measured lightweight and learned
detector experiments. These development results do not certify a release.

Rendering is an explicit local developer operation. Its case manifest supplies
public imagery URLs for GET requests; it does not upload local file contents.
The JPEG cache uses bounded streaming, safe image identifiers and exclusive file
creation. Existing cache entries must be regular files; symlinks are rejected.
