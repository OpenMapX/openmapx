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
these namespaces out of every public page's payload; the admin layout provides
the full catalogue to admin pages. The list lives in
`apps/web/src/i18n/adminMessages.ts`, and a test fails when code a public page
can load reads one of them. Admin code that renders on public pages, such as
the impersonation banner (`impersonation`) and the unsaved-draft guard
(`adminDrafts`), uses public namespaces.

Settings the API defines keep their English label and description on the
server; `adminSettings.settings.<key>` translates them in the admin UI, and a
setting the catalogue does not know keeps the server's text. Titles in
integration and service `configSchema`s stay English, because community
manifests have no catalogue.

Server components use `getTranslations`; `pnpm check-translations` recognizes it
alongside `useTranslations` and `createTranslator`. In admin directories, Biome
rejects literal text between JSX tags (`noJsxLiterals`) and literal words in
props that show text (`scripts/biome-plugins/noLiteralCopyProps.grit`). The
override in `biome.json` lists the sections not yet localized: cache, settings,
system maintenance, the application log and the audit log.
