---
"@openmapx/extension-contracts": minor
"@openmapx/extension-cli": minor
---

Config keys have one style per manifest kind. Integration manifests refuse a `configSchema.properties` key that is not lowerCamel (`apiKey`, `rateLimitPerIpPerHour`), including an upper-case run such as `APIKey` or a trailing capital, so each host variable names one key; OpenMapX derives the host variable by splitting its words, `INTEGRATION_<ID>_RATE_LIMIT_PER_IP_PER_HOUR`. Service manifests refuse a key that is not UPPER_SNAKE (`BUILD_ELEVATION`), used as is in `SERVICE_<ID>_<KEY>`. Rename kebab-case or snake_case keys accordingly.
