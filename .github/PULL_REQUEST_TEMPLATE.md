<!--
Thanks for the PR!

Title: Conventional Commits format (e.g. `feat(transit-hafas): add DB long-distance`).
The `pr-title` GitHub Action will reject non-conformant titles.

For anything non-trivial, please open an issue first so we can align on approach.
Mark the PR as a Draft if it isn't ready for review yet.
-->

## Summary

<!-- What does this change, and why? 1–3 bullets. -->

-

## Related issues

<!-- Link issues this addresses. "Fixes #123" auto-closes them on merge. -->

Fixes #

## How was this tested?

<!--
- `pnpm lint && pnpm check-types && pnpm test` locally
- Manual verification (which feature, browser, dataset, service/integration)?
- New tests added under which path?
-->

-

## Checklist

- [ ] Conventional Commits title (the `pr-title` check enforces this)
- [ ] `pnpm lint && pnpm check-types && pnpm test` pass locally
- [ ] Added / updated a [changeset](https://github.com/changesets/changesets) if a publishable package changed
- [ ] Docs updated if behavior is user-visible (README and/or [docs.openmapx.org](https://docs.openmapx.org) sources under `docs/`)
- [ ] New code carries the right license header / lands in the correct license tier (see [LICENSING.md](../LICENSING.md))
- [ ] No secrets, real API keys, or `.env` files committed
- [ ] I agree to the [Contributor License Agreement](../CLA.md) (the CLA bot will prompt on your first PR)
