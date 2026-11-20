# Shared translations

The JSON files in `locales/` are the canonical message catalogues for the web,
mobile, API, and background tasks. Add a language in four steps:

1. Add its catalogue to `locales/`.
2. Register it in `messages` in `config.ts`.
3. Add its tag to `locales` and its display name to `localeNames` in `locale.ts`.
4. Run `pnpm -C packages/i18n exec tsx scripts/generate-navigation-cue-messages.ts`.

Keep the same keys and ICU placeholders in every language; run
`pnpm check-translations` from the repository root to validate them.

Browser code imports `@openmapx/i18n/locale` (locales, `resolveLocale`) and
`@openmapx/i18n/navigationCuesCompact` (spoken cues), not the barrel, so client
bundles do not carry every catalogue; a Biome rule enforces this in the web app
and integrations. The compact cue module reads
`generated/navigation-cue-messages.json`, a copy of the cue messages listed in
`NAVIGATION_CUE_KEYS`. After editing any of those 17 `navigation` messages, rerun
the generator above, or `navigationCuesCompact.test.ts` fails.

Web components use `next-intl` (`useTranslations` and `useFormatter`). Headless
code uses the existing `intl-messageformat` dependency through:

```ts
import { createTranslator, resolveLocale } from "@openmapx/i18n";

const locale = resolveLocale(request.locale);
const t = createTranslator(locale, "privacyExport.readme");
const title = t("title");
```

The resolver prefers an exact registered locale, then less specific language
tags (for example `de-AT` → `de`), then `defaultLocale`. The formatter falls back
per message to the default catalogue and throws for unknown keys. It returns
plain text; callers must escape it when embedding it in HTML. Use ICU arguments
for variable text instead of assembling translated sentences from fragments.

Privacy export copy lives in `privacyExport`, admin interface copy in
`privacyAdmin`, and account interface copy in `account.privacyData`. Adding a
language does not require new privacy-specific branches or locale enums.

## Admin copy

The admin area has one namespace per section: `adminActivity`, `adminExtensions`,
`adminIntegrations`, `adminOverview`, `adminServices`, `adminTransit`,
`adminUsers`, the shell and shared controls in `adminShared`, page titles and
headers in `adminPages`, plus the earlier `adminCoverage`, `adminNavigation`,
`adminSearchIndex`, `privacyAdmin` and `privacySetup`. The root layout leaves
these namespaces out of every public page's payload; the admin layout sends
only these namespaces, and `AdminMessagesProvider` adds them to the public
catalogue already on the page, because a nested provider replaces its parent's
messages instead of merging them. The list lives in
`apps/web/src/i18n/adminMessages.ts`, and a test fails when code a public page
can load reads one of them. Admin code that renders on public pages, such as
the impersonation banner (`impersonation`) and the unsaved-draft guard
(`adminDrafts`), uses public namespaces.

Settings the API defines keep their English label and description on the
server; `adminSettings.settings.<key>` translates them in the admin UI, and a
setting the catalogue does not know keeps the server's text. Titles in
integration and service `configSchema`s stay English, because community
manifests have no catalogue.

Admin messages are whole sentences. Inline markup such as `<code>` or
`<strong>` goes through `t.rich` tags, counts use ICU plurals, and code values
such as statuses go through ICU `select` (select keys cannot hold hyphens or
dots, so `self-hosted` is passed as `self_hosted`). Argument names carry the
convention, and `adminMessageArguments.test.ts` enforces it for every admin
message: an argument named like a code (`status`, `state`, `action`, `source`,
`reason`, …) must be a `select`, whose `other` branch may repeat the raw code
for codes added later, and a label already worded by a helper is passed under
a name ending in `Label`, such as `{statusLabel}`. Open-ended server codes,
such as audit actions, are keyed messages (`adminShared.auditActions.<code>`)
read through a helper that shows the server's code only when the catalogue
does not know it. Counts go to ICU as `{count, number}` or a plural, so they
group in the reader's locale; the same test rejects a plain count argument
and a unit glued to an argument (`{ms}ms`, `{percent}%`). Sizes, percentages,
durations, dates and times come from `useAdminFormat()`
(`apps/web/src/lib/admin/adminFormat.ts`), which formats in the locale the
reader chose and follows their date and time settings; a test refuses
`toFixed`, `toLocale…()` without that locale and hand-glued units in the admin
tree. Commands, environment variable names
and other strings that read the same in every language are message arguments,
not catalogue text. Shared verbs such as Cancel, Close, Retry and Confirm come
from `common`. A helper outside a component declares the namespace it reads as
`AdminTranslator<"adminServices">` (`apps/web/src/lib/admin/adminTranslator.ts`),
and the component passes the translator from `useAdminTranslations`, so a
translator for another namespace does not compile.

Server components use `getTranslations`; `pnpm check-translations` recognizes it
alongside `useTranslations` and `createTranslator`. In admin directories, Biome
rejects literal text between JSX tags (`noJsxLiterals`), and
`scripts/biome-plugins/noLiteralCopy.grit` rejects string literals with words
wherever else they reach the screen: expression children, props and object
keys that show text, label maps, values handed to a translator, toast,
snackbar, error-setter and job-report messages, `on…Error` callbacks and
`new AdminDisplayError(…)`. It follows ternary branches,
`??`, `||` and `&&` operands, `+` concatenation and template literals.
Strings that read the same in every language, such as the product name,
environment variable names, commands, file names, licence identifiers and
example input values, stay in source; the plugin's `non_copy` pattern lists
them explicitly. Write them as expression children (`<code>{"…"}</code>`) so
`noJsxLiterals` leaves them alone too. `scripts/biome-plugins/noRawCodeCopy.grit`
rejects a code field, such as `job.status` or `stage.state`, rendered straight
into a child, a text prop or a template; a field that holds written text
rather than a code takes a `biome-ignore lint/plugin/noRawCodeCopy` comment
that says so. The override in `biome.json` lists the
sections not yet localized: cache, settings, system maintenance, the
application log and the audit log; `lib/admin` is checked by the plugin only.

The plugins read syntax, not data flow, so some shapes stay out of their
reach and are left to review: copy held in a variable before it is shown
(`const s = on ? "Running" : "Stopped"`), copy returned from a helper or a
`switch`, setters whose name does not say they hold a message (`setStatus`),
and a code read through a renamed variable. A plain `throw new Error("…")`
is not reported because `adminErrorText` never shows its message; only an
`AdminDisplayError` reaches the screen.
