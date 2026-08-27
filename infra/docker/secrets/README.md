# OpenMapX secrets directory

Operator-provided and deployment-generated secret files mounted into containers
at runtime. Files in this directory are gitignored by default (see `.gitignore`).

## Files

### `offline-package-principal-key` (generated, API only)

Every CLI compose render creates this HMAC key when it is absent. It is exactly
32 bytes from the operating-system CSPRNG encoded as 43 canonical base64url
characters, with no padding or newline. Existing canonical keys are reused and
never trimmed or silently rotated. The same protected-directory, owner,
single-link, and exact `0444` file rules described for the generated Redis
credential apply.

Only `app-api` receives the read-only bind mount and its file-path/expected-owner
configuration. Data-manager never receives the key or a raw account/session
identifier; it sees only a lowercase 64-hex HMAC principal over the existing
authenticated service connection. The key value must never enter Compose
environment values, URLs, request bodies, responses, labels, commands, images,
or logs.

Rotating the key intentionally changes every derived principal. Stop app-api,
drain or let current package preparations finish, atomically replace the file
with another canonical generated value, then recreate app-api. Existing
content-addressed artifact URLs remain usable, but old job-status ownership and
retention-accounting identities cannot be resumed through the new principal;
users prepare again to acquire new ownership records. Ordinary compose render
does not rotate this key.

### `ops-agent-api-token` and `ops-agent-data-manager-token` (generated)

Every CLI compose render creates the two ops-agent caller credentials when they
are absent. Each credential is an independent 32-byte CSPRNG value encoded as
exactly 43 base64url characters, with no padding or trailing newline. Existing
canonical credentials are reused, never silently rotated or trimmed, and a
render fails closed if the two files contain the same value. Their protected
directory, ownership, single-link, and `0444` file requirements are the same as
for the generated Redis credential below.

The API credential is mounted only into `app-api` and `ops-agent`; the
data-manager credential is mounted only into `data-manager` and `ops-agent`.
Callers receive only a token **file path** in their environment. Raw bearer
values must not be copied into Compose environment entries, URLs, labels,
commands, logs, or images.

There is not yet a live or single-caller rotation protocol. Rotation must stop
all three credential holders, replace both files as one coordinated maintenance
event, and recreate `ops-agent`, `app-api`, and `data-manager` before any caller
resumes. Ordinary compose rendering does not perform that rotation. Until the
coordinated rotation command lands, do not delete, edit, or move either token
while any of those containers is running.

### `transitous-runner-capability` (generated)

Every CLI compose render creates this signing key when it is absent, using the
same 32-byte CSPRNG value encoded as exactly 43 base64url characters as the
other generated credentials, and reuses an existing canonical file rather than
rotating it. The protected-directory, ownership, single-link, and `0444` file
rules are identical to those described for the generated Redis credential below.

It is mounted read-only into exactly two containers: `data-manager`, which signs
one short-lived capability token per upstream Transitous run, and
`transitous-runner`, which verifies that signature and refuses a token it has
already honoured. Nothing else in the stack holds it, and no token or key value
belongs in Compose environment values, URLs, labels, commands, or logs — only
the file path does.

Rotation is a two-container maintenance event: stop `data-manager` and
`transitous-runner`, replace the file, then recreate both. A run dispatched
across the change fails authorization and is retried by the next sync rather
than silently executing. Ordinary compose rendering does not rotate the key.

### `redis-password` and `redis-acl.conf` (generated)

Every CLI compose render creates `redis-password` when it is absent, using 32
bytes from the operating system CSPRNG encoded as exactly 43 base64url
characters (no padding or trailing newline). Ordinary renders reuse the existing
password; they never rotate it. Noncanonical existing files are rejected rather
than trimmed. The same render atomically replaces `redis-acl.conf`, which
contains only Valkey ACL directives and the SHA-256 hash of the password. It
then rereads both authoritative files and retries a bounded number of times if a
concurrent render or rotation changed either generation. The raw value is
mounted only into Valkey, app-api, and data-manager. It is not written into
Compose environment values, URLs, labels, commands, or health-check command
text.

The helper makes this directory mode `0700`, verifies that it belongs to the
invoking user, and requires each authoritative file to have the same owner and
exactly one hard link. This is the host-side secrecy boundary. The two files are
mode `0444`. Docker Compose outside swarm preserves
the source-file mode on these bind mounts; `0444` is therefore required for
the non-root data-manager container to read its individually mounted password
file. Other host users cannot traverse the `0700` parent directory.

To rotate Redis credentials, do not delete or edit either generated file. The
rotation command validates both authoritative targets, then fully writes,
syncs, and chmods exclusive password and ACL candidates in this protected
directory before the first commit. Each candidate is renamed atomically over
its corresponding existing single-link file, so neither path is delete-first.
The two renames are intentionally sequential, not one two-file transaction:
clients must remain stopped across the possible crash boundary. Every
successful render and rotation performs bounded reconciliation against the
authoritative password, so overlapping successful operations converge on a
matching ACL. Run this exact order from the repository root:

1. `pnpm openmapx services stop app-api data-manager`
2. `pnpm openmapx compose rotate-redis-password --confirm-clients-stopped`
3. `pnpm openmapx services update redis` (renders the matching ACL and force-recreates Valkey)
4. Wait until `redis` is healthy; its health check authenticates from the same
   password file.
5. `pnpm openmapx services start app-api data-manager`

The command never prints or returns the password or its hash. Predictable ACL
candidate failures happen before the password commit and leave both old files
authoritative. If the process crashes between per-file commits, or reports that
the password commit succeeded but the ACL commit failed, keep all clients
stopped and run `pnpm openmapx compose render`; this reconciles the ACL to the
authoritative password. If render itself rejects a malformed ACL target (for
example a symlink, directory, owner mismatch, or extra hard link), quarantine
that invalid path without following or deleting it, then render again:

```bash
mv infra/docker/secrets/redis-acl.conf infra/docker/secrets/redis-acl.conf.quarantine
pnpm openmapx compose render
```

Use an unused quarantine name and inspect it before later removal. The brief
absent ACL path in this exceptional repair is safe only because Redis clients
remain stopped and Redis is recreated after reconciliation. Never delete the
password or attempt recovery while clients are running.

Redis cache/state is disposable in this deployment, so there is no dual-password
transition. Starting clients before Valkey has loaded the matching ACL can cause
authentication failures; leaving an old client running during rotation keeps an
obsolete password in that process's memory.

### `transitous-feed-proxy.age` (optional)

age v1 private key (RFC 9106 `-----BEGIN AGE ENCRYPTED FILE-----` format)
used by Transitous's `src/utils.py` to decrypt `AGE-ENCRYPTED:` values in
feed JSON files.

Generate locally:

    age-keygen -o infra/docker/secrets/transitous-feed-proxy.age
    chmod 0600 infra/docker/secrets/transitous-feed-proxy.age

Then add the corresponding public key (`age-keygen` prints it to stderr) to
the Transitous PR / configuration for any feed source you want to consume
under encryption. See https://github.com/public-transport/transitous for the
upstream policy.

When this file is absent, the data-manager logs a startup warning and skips
encrypted feed values. The pipeline continues normally for unencrypted feeds.
