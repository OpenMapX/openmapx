# Volunteer beta evidence

Store sanitized physical-device reports here. No beta report JSON files are
currently committed. The repository records signing placeholders and a
provisional location-driver decision; it does not establish live store-account,
upload or volunteer activity.

Before collecting navigation evidence, compose the foreground bridge dispatcher
and qualify the candidate. `src/App.tsx` currently advertises no native navigation
capabilities. A helper test or feasibility overlay is not a store-beta run.

## What each report must be

Use one report per device family, following
`../../release/release-candidate-report.schema.json`, with
`environment.virtual: false`. Record source commit, marketing version, build
number, OS/device family and web build ID. Expected family paths are:

- `1.0.0-ios.json`: current-iOS iPhone.
- `1.0.0-pixel.json`: Android API 36 Pixel-class device.
- `1.0.0-samsung.json`: recent Samsung with default battery management.

The schema requires `candidate.artifactSha256`. Retain the uploaded artifact hash
and store processing/install identity. If a processed-package hash is obtainable,
record it and its acquisition method in scenario notes or referenced evidence.
Store re-signing/thinning can change delivered bytes. Do not present an uploaded
hash as a measurement of the installed package. If the required installed-artifact
binding cannot be established, record the limitation and leave qualification open;
do not invent a hash.

The release schema permits free-text notes and measurements. Review them for
privacy manually. It does not enforce physical-only evidence or scenario
completeness. `mobile:qa:validate` validates the **feasibility** schema, not this
release-candidate schema. To check a release report's shape from the repository
root:

```bash
pnpm -C apps/mobile exec node --input-type=module - qa/results/beta/1.0.0-ios.json <<'JS'
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
const schema = JSON.parse(readFileSync("qa/release/release-candidate-report.schema.json", "utf8"));
const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const validate = new Ajv2020({ allErrors: true, allowUnionTypes: true }).compile(schema);
if (!validate(report)) {
  console.error(validate.errors);
  process.exitCode = 1;
}
JS
```

Replace the filename with the actual report. If starting from
`../../release/rc-template.json`, remove its root `$comment`, replace placeholders
and discard prefilled outcomes. `pending-physical` applies only to hardware cases
left open during virtual qualification; it cannot stand in for an unrun case.

## What only these runs can establish

- Background guidance through real OS suspension and a representative trip.
- Locked-screen alerts under actual notification, Focus and Do Not Disturb settings.
- Speech latency and audio focus with Bluetooth and calls.
- Battery drain, thermal behavior and OEM service termination.
- Passkeys, real provider consent and verified links on the signed installed app.

Use the ground, transit and secure-shell scenario files. Associate each result
with its tester through a consented identifier or a private evidence record; keep
personal identity and device serials out of public JSON. Public rollout remains
blocked until all three family reports and every driver risk are reviewed.

## Sanitisation

Exclude coordinates, addresses, accounts/emails, device identifiers, tokens,
notification content, trip IDs, stop names and precise service times. Describe a
route as "a 40-minute suburban drive". Publish only outcomes from actual runs;
leave missing evidence unresolved.
