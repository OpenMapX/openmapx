---
impacts: [security]
---

## What changes

The operations agent no longer decides what to trust from the checkout's file
permissions. A checkout written under a umask of `002`, as `git clone` and
`git pull` leave it on Debian and Ubuntu, now starts the agent and serves its
requests without any `chmod`.

- Built-in integration schemas come from the ops-agent image of the selected
  release, like the built-in service manifests.
- Community services installed from extension repositories are trusted by
  digest. When the agent installs a commit, it records the SHA-256 of every
  `service.json` it validated; the agent, and the CLI it runs for updates,
  builds, backups and data commands, load only recorded manifests whose bytes
  still match. That CLI previously read community services and integration
  schemas from the checkout without any check.
- The configuration writer removes group and other write access from
  `infra/docker`, which holds the current configuration pointer, when its own
  user owns it, instead of refusing to render.
- Installed integrations under `custom_integrations/` keep their owner and mode
  checks until their installer controls the file modes it writes.

It also fixes trusted configuration requests (applying settings, the service
selection or secrets from the admin panel): the agent bound each request to one
form of its authority revision and checked another, so every request ended
"not committed".

## Who is affected

Every Docker deployment. Repositories installed by an earlier release have no
digests in their records; no deployment is known to have one.

## Required action

None. If the agent refuses to start with "Trusted configuration authority
rejected" because of a repository installed by an earlier release, delete that
repository's directory and its `.repository-<hash>.json` under
`services/.community/` and install the extension again.
