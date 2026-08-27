import z from "zod/v4";

/**
 * Contract for the private Transitous runner.
 *
 * Upstream Transitous is third-party Python that moves independently of this
 * repository. Executing it inside data-manager gave that code the same
 * filesystem, network, and credential reach as the service that owns `/data`.
 * The runner is a separate, private worker whose entrypoint is fixed: callers
 * name one of a closed set of scripts and a bounded, validated argument set —
 * never a command, a path outside the catalog, or arbitrary argv.
 *
 * Every request carries a one-run capability token. The token authorizes
 * exactly one execution, so a leaked token cannot be replayed into a second
 * run.
 */

export const TRANSITOUS_RUNNER_PROTOCOL_VERSION = 1 as const;

/** Wall-clock ceiling for one upstream script. */
export const TRANSITOUS_RUNNER_TIMEOUT_MS = 30 * 60_000;
/** Captured stdout/stderr ceiling; upstream output is diagnostic, not data. */
export const TRANSITOUS_RUNNER_MAX_OUTPUT_BYTES = 1024 * 1024;
/** Countries are ISO-3166-1 alpha-2 region selectors passed straight through. */
const countrySchema = z.string().regex(/^[a-z]{2}$/);

/**
 * A catalog-relative feed path. Anchored to `feeds/`, no traversal, no
 * absolute path — the runner resolves it against its read-only catalog mount
 * and refuses anything that escapes.
 */
const feedPathSchema = z
  .string()
  .min(7)
  .max(512)
  .regex(/^feeds\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/);

/**
 * A file name — never a path — inside the operator-metadata staging directory.
 * Operator feeds are acquired from metadata this platform writes rather than
 * from the catalog, so the runner resolves the name against that one directory
 * and refuses anything that leaves it.
 */
const operatorMetadataNameSchema = z
  .string()
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/);

/** Where operator metadata is reachable from inside the catalog checkout. */
export const OPERATOR_METADATA_DIR = "downloads/operator-metadata";

/**
 * The closed set of upstream entrypoints. Adding a legitimate script means
 * adding a typed case here with its own validated arguments; there is
 * deliberately no `command`, `args`, `script`, or `cwd` escape hatch.
 */
export const transitousRunnerScriptSchema = z.discriminatedUnion("script", [
  z.strictObject({ script: z.literal("fetch"), feedPath: feedPathSchema }),
  z.strictObject({
    script: z.literal("fetch-operator"),
    metadataName: operatorMetadataNameSchema,
  }),
  z.strictObject({ script: z.literal("garbage-collect") }),
  z.strictObject({ script: z.literal("generate-attribution") }),
  z.strictObject({
    script: z.literal("generate-motis-config"),
    importOnly: z.boolean(),
    feedProxy: z.boolean(),
    countries: z.array(countrySchema).max(64),
  }),
  // The upstream `run.sh` merges the `--feed-proxy` YAML output with the
  // catalog whitelist and emits JSON. The runner owns that fixed snippet so no
  // caller ever supplies Python source.
  z.strictObject({ script: z.literal("feed-proxy-vars-to-json") }),
]);

export type TransitousRunnerScript = z.infer<typeof transitousRunnerScriptSchema>;

export const transitousRunnerRequestSchema = z.strictObject({
  version: z.literal(TRANSITOUS_RUNNER_PROTOCOL_VERSION),
  /** Single-use capability token minted by the caller for this one run. */
  capability: z.string().regex(/^trc1_[A-Za-z0-9_-]{32,128}$/),
  run: transitousRunnerScriptSchema,
});

export type TransitousRunnerRequest = z.infer<typeof transitousRunnerRequestSchema>;

export const transitousRunnerResultSchema = z.strictObject({
  version: z.literal(TRANSITOUS_RUNNER_PROTOCOL_VERSION),
  ok: z.boolean(),
  exitCode: z.number().int(),
  /** Bounded, already-truncated diagnostic output. Never a credential or URL. */
  output: z.string().max(TRANSITOUS_RUNNER_MAX_OUTPUT_BYTES),
  truncated: z.boolean(),
  durationMs: z.number().int().nonnegative(),
});

export type TransitousRunnerResult = z.infer<typeof transitousRunnerResultSchema>;

/**
 * The exact argv the runner executes for a script. Exported so both the runner
 * and its tests assert on one definition rather than two that can drift.
 */
export function transitousRunnerArgv(run: TransitousRunnerScript): string[] {
  switch (run.script) {
    case "fetch":
      return ["./src/fetch.py", run.feedPath];
    case "fetch-operator":
      return ["./src/fetch.py", `${OPERATOR_METADATA_DIR}/${run.metadataName}`];
    case "garbage-collect":
      return ["./src/garbage-collect.py", "--non-interactive"];
    case "generate-attribution":
      return ["./src/generate-attribution.py"];
    case "generate-motis-config":
      return [
        "./src/generate-motis-config.py",
        ...(run.importOnly ? ["--import-only"] : []),
        ...(run.feedProxy ? ["--feed-proxy"] : []),
        "--skip-missing-files",
        ...run.countries,
      ];
    case "feed-proxy-vars-to-json":
      return ["-c", FEED_PROXY_VARS_TO_JSON_PY];
  }
}

/**
 * Fixed inline snippet, owned here rather than supplied by a caller. Mirrors
 * upstream `run.sh`: merge the `--feed-proxy` YAML output with the catalog's
 * feed whitelist and emit JSON into `out/`.
 */
export const FEED_PROXY_VARS_TO_JSON_PY = `import json
from pathlib import Path
from ruamel.yaml import YAML

yaml = YAML(typ="safe")
feed_vars: dict = {}
for path in (
    Path("/tmp/feed-proxy-vars.yml"),
    Path("ansible/roles/feed-proxy/vars/feed-whitelist.yml"),
):
    if not path.exists():
        continue
    loaded = yaml.load(path.read_text()) or {}
    if isinstance(loaded, dict):
        feed_vars.update(loaded)
out = Path("out")
out.mkdir(parents=True, exist_ok=True)
(out / "feed-proxy-vars.json").write_text(json.dumps(feed_vars, indent=2, sort_keys=True) + "\\n")
`;
