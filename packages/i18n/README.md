# Shared translations

The JSON files in `locales/` are the canonical message catalogues for the web,
mobile, API, and background tasks. Add a language by adding its catalogue and
registering it and its display name in `config.ts`. Keep the same keys and ICU
placeholders in every language; run `pnpm check-translations` from the repository
root to validate them.

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
