---
title: Writing documentation
description: Where to put documentation, how to write a useful guide, and how to check the site.
---

# Writing documentation

The documentation site lives in `docs/` and is a separate pnpm workspace.
Published articles are Markdown files under `docs/docs/`. The repository
README introduces the project; it should link to detailed instructions instead
of repeating them.

## Choose the reader and task

Place a page according to what the reader needs to do:

| Content                                                            | Location                    |
| ------------------------------------------------------------------ | --------------------------- |
| First use, concepts, and help                                      | `docs/docs/overview/`       |
| Using an application feature                                       | `docs/docs/features/`       |
| Installing, configuring, or upgrading an instance                  | `docs/docs/install/`        |
| Choosing and operating an optional backend                         | `docs/docs/guides/`         |
| Routine administration and recovery                                | `docs/docs/administration/` |
| Code architecture, interfaces, development, and release procedures | `docs/docs/developer/`      |
| Version-specific product release notes                             | `docs/docs/releases/`       |

Start a feature guide with how to use the feature and what must be enabled.
Keep internal schemas, cache algorithms, and implementation walkthroughs in
developer references. Link to the reference when a user needs the detail.

Keep execution plans, investigation receipts, and acceptance fixtures outside
the published article tree unless they serve an ongoing operator or developer
task. A release qualification page must distinguish a required check from a
recorded result. Never replace a pending runtime check with a claim based only
on source review or unit tests.

## Write instructions someone can follow

Use a short introduction that explains the outcome and any significant limit.
Put prerequisites before the first step: required access, enabled services,
credentials, source data, and the directory from which to run commands.

Use numbered steps when order matters. Show complete commands, then explain
what the reader should see and how to check the result. Mark placeholders and
optional steps explicitly. Before a destructive step, state what it deletes
and what backup or recovery path is needed.

Use the application's visible labels for controls. Explain whether a setting
belongs in the admin panel, the deployment environment, or an individual app's
development environment. Do not assume that a host process can resolve Docker
service names or reach private container ports.

For reference pages, use tables for settings, defaults, and alternatives.
Include units and the scope of each limit. Examples must use actual supported
fields, types, commands, and response shapes.

## Keep the prose direct

Use plain technical English, active verbs, and sentence-case headings. Explain
an unfamiliar term when it first matters. Keep each paragraph about one idea.

Describe behavior precisely. Replace claims such as "works everywhere" or
"fully private" with the actual coverage or trust boundary. Preserve warnings
and distinctions that affect a decision, including server-readable data,
provider licences, optional features, and unsupported operations.

Remove introductions that repeat the heading, conclusions that repeat the
paragraph, decorative emphasis, and accounts of how the documentation was
written. Use bold for visible UI labels or a warning that needs emphasis.
Avoid making every list item a bold label followed by a colon.

## Links and presentation

Give each article a descriptive frontmatter `title` and `description`. A short
page needs fewer headings than a contract reference. Use admonitions for a
specific caution or prerequisite, close to the action they affect.

Use relative Markdown links between articles. For source files outside the
published article tree, link to the file on GitHub rather than a relative path
that the site cannot serve. Keep existing paths when reorganizing the sidebar. If you rename a heading, update inbound links or
retain an explicit heading ID with the MDX comment syntax used by this site:

```markdown
## Configure the provider {/* #provider-configuration */}
```

The sidebar is defined in `docs/sidebars.ts`; add a new page to its appropriate
group. Reorganizing navigation does not require moving source files. Images
belong in `docs/static/img/` and need useful alternative text. Diagrams should
explain a relationship that would be harder to follow in prose. Keep each
diagram focused, supply Mermaid `accTitle` and `accDescr` text for assistive
technology, and inspect its labels at a narrow width. Wrap a wide diagram in a focusable `docs-diagram` region, give it an accessible
label, and set `--diagram-min-width` to a width where its labels remain readable.
The region supports horizontal keyboard scrolling; see the
[architecture examples](./architecture.md#runtime-topology).

## Verify a change

From the repository root, install both locked dependency sets:

```bash
pnpm install --frozen-lockfile
pnpm -C docs install --frozen-lockfile
```

Check only the Markdown files you changed with the root Prettier installation,
then check and build the site:

```bash
pnpm exec prettier --check docs/docs/developer/documentation.md
pnpm -C docs typecheck
pnpm -C docs build
pnpm -C docs serve --host 127.0.0.1 --port 3005 --no-open
```

Open `http://127.0.0.1:3005`. Inspect changed navigation, tables, code blocks,
and diagrams. For presentation changes, check a narrow screen and both light
and dark themes. The production build rejects broken internal links and
anchors; it cannot prove that a command works or a privacy claim matches the
implementation.

Compare technical claims with the code that owns them: CLI help and command
definitions, service manifests, environment examples, exported types, runtime
guards, and workflow jobs. Run an example in a disposable environment when its
behavior matters. Report checks that could not be performed, particularly
database restores, deployment rehearsals, live provider calls, or native-device
steps. Documentation changes usually need formatting and a docs build; use the
[contribution quality bar](https://github.com/OpenMapX/openmapx/blob/main/CONTRIBUTING.md#quality-bar)
for changes that also affect code or tooling.
