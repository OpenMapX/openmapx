---
impacts: [breaking, migration]
---

## What changes

The API's database migration history is replaced by a single baseline: one
migration that drizzle-kit generates from the schema code, and one that adds the
roles' grants, the account role check and the last-administrator guard. The
resulting schema is the same as before, apart from the order of some columns and
the changes below.

The database refuses a second account for the same sign-in provider identity and
a second passkey with the same credential ID. Session and OAuth token expiry are
indexed for pruning.

## Who is affected

Every database created by an earlier development build, including local
development databases. No released installation exists.

## Required action

Install fresh with an empty database volume. The API refuses to start on a
database created before this change and reports that a relation already exists;
there is no upgrade path. Recreate local development databases and apply the
migrations again.
