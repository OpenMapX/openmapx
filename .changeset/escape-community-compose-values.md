---
"@openmapx/extension-contracts": minor
"@openmapx/extension-cli": minor
---

Tighten the community service sandbox. A third-party service manifest can no longer declare a `container.logging` block or a `consumes` entry with `readOnly: false`, and `exposure.hostPorts[].bindAddress` must be an IPv4 or IPv6 address. Remove `logging` and writable `consumes` from community manifests and replace hostnames or Compose references in `bindAddress` with an IP address; community `consumes` mounts are always read-only. First-party manifests are unchanged. The extension CLI applies the same checks when it validates a service manifest.
