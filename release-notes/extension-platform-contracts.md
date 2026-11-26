---
impacts: [breaking, migration]
---

## What changes

The extension contracts, the API database and the operations agent's records
gain what installed extension code will need. Apart from the stored attention
list below, nothing uses the additions yet.

The API database baseline gains twelve tables: `extension_migration`,
`integration_task_run`, `extension_setting`, `extension_name_claim`,
`extension_catalog_source`, `extension_revocation_snapshot`,
`extension_advisory_ack`, `subject_erasure_pending`,
`integration_subject_handler`, `attention_item`, `attention_observation` and
`attention_notification`. An installed extension records whether it is enabled
and the grants an administrator approved; the database refuses an approved-grants
value that is not an object of distinct, sorted lists. An installed extension
component can record its resolved commit and image digest. Service and
integration configuration, their secrets and capability bindings can record
the extension that owns them, and configuration rows carry a schema version.
The admin job vocabulary gains `extension.enable`, `extension.disable` and
`extension.purge`, the personal-data source vocabulary gains `extension`, and
four settings join a new `extensions` group: `extensions.catalogSource`,
`extensions.revocationCheck`, `extensions.remoteDisable` and
`extensions.prereleaseOptIn`. They are listed by the settings API, but nothing
reads them yet and the admin interface does not show them.

Deleting an account, however it is deleted, records a pending erasure for each
integration that has registered a personal-data handler. No integration can
register one yet.

The PostGIS entrypoint lets the API's database role create schemas named
`ext_<id>`, reserved for installed integrations, or rename a schema to such a name,
besides `data_manager` and `drizzle`.

The operations agent's community repository records carry the approved grants
(`{}` until grants ship), and a record may be up to 1 MiB. An integration may
hold 1,024 files instead of 128. An install is refused when the files and
source URLs of all installed integrations would exceed what one inspection can
report, and a refused install now names its reason instead of a generic
message.

`GET /api/admin/attention` lists stored attention items and
`POST /api/admin/attention/:key/acknowledge` acknowledges one, recorded in the
audit log as `attention.acknowledge`. Stored items appear first in the admin
overview's attention list. Nothing raises one yet.

Extension manifests change in breaking ways:

- Integration manifests lose `backend.cron`, and the `backend` object refuses unknown keys. `frontend.panel` is an object, such as `{}` or `{ "detents": "place" }`; `true` and `false` are refused.
- Service manifests lose `exposure.proxy.authRequired`, and the proxy object refuses unknown keys. A device path is at most 255 characters. `ownsSchema` must start with a letter and have at most 63 characters.
- Extension manifests lose `readiness`. A `config[]` entry has a lowerCamel `key` and a `targets` list instead of one `target`.

A service manifest's `requests`, an extension's `config[]` and
`services[].optional` are accepted and have no effect until grants and
extension settings ship.

## Who is affected

Every installation, because the database baseline changes. Every author of an
integration, service or extension manifest that uses a removed field or the old
`panel` or `config[]` shape.

## Required action

A new installation needs no action. A database or operations agent state
created by an earlier development build cannot be upgraded: recreate the
database volume and the agent state and apply the migrations again. No released
version precedes this baseline.

Extension authors: replace `config[].target` with `targets: [{ component, key }]`,
write `config[].key` in lowerCamel, replace `"panel": true` with `"panel": {}`,
and delete `"panel": false`, `readiness`, `backend.cron` and `authRequired`.
Rename an `ownsSchema` that starts with `_` or is longer than 63 characters.
`openmapx-ext validate` names each of them.
