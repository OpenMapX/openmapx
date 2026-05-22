# OpenMapX secrets directory

Operator-provided secret files mounted into containers at runtime. Files in
this directory are gitignored by default (see `.gitignore`).

## Files

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
