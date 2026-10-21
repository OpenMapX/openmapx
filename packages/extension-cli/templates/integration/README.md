# `__ID__`

Declarative OpenMapX integration for the `__DOMAIN__` domain. Fill in `manifest.json`, localized strings and any declared static assets. Keep executable behavior in a separate companion service connected through a supported host protocol or reviewed adapter.

## Install the authoring tools

Use Node.js 24.22.1 or newer. Once the matching CLI version is published:

```sh
npm install --ignore-scripts
```

Before publication, copy the candidate CLI tarball built from OpenMapX into this project's `tools/extension-cli.tgz`, then install it:

```sh
npm install --save-dev --ignore-scripts ./tools/extension-cli.tgz
```

Commit `package.json` and `package-lock.json`. For a candidate dependency, commit `tools/extension-cli.tgz` too so a clean checkout can install the exact same tool. Ignore `node_modules/` in your repository. Do not commit credentials or application environment files.

## Validate and package

These are the same commands used by the generated CI workflow:

```sh
npm ci --ignore-scripts
npm run validate
npm run package
```

The output is `../__ID__.tar.gz`. Validation checks the declarative manifest and referenced assets. It does not prove provider access, companion-service readiness or host authorization. Authoring files, CI configuration and development dependencies are excluded from the artifact.

## CI

The generated `.github/workflows/validate.yml` assumes this directory is the repository root and the main branch is named `main`. It validates and packages pull requests and main-branch pushes, then retains the candidate for seven days. It does not publish a release or install anything into a host. Review dependency and action updates before adopting them.

If this integration is nested in a larger repository, move the workflow into that repository's root `.github/workflows/`. Set the job's `defaults.run.working-directory` to the integration directory and adjust the upload step's `path` relative to the repository root; `defaults.run` does not affect action inputs. Update the branch filter if needed. Do not enable the workflow before committing the lockfile and any local candidate tarball it references.

## Try it in OpenMapX

Use a separate development host and install the packaged artifact, not this authoring directory. Follow the [external extension guide](https://docs.openmapx.org/developer/building-an-external-extension/#test-in-a-local-development-host) for host setup, installation, reload, update and removal. A declarative manifest alone does not register a runtime provider or add executable UI.
