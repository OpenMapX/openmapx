# OpenMapX documentation

The OpenMapX documentation site (https://docs.openmapx.com), built with
[Docusaurus](https://docusaurus.io/). Content lives in `docs/`; the site is
fully prerendered to static files.

This package is **not** part of the monorepo's pnpm workspace. Install and run
it standalone so the workspace's strict install policies don't apply to
Docusaurus's dependency tree:

```bash
cd docs
pnpm install --ignore-workspace
pnpm start          # dev server with live reload
pnpm build          # static output in ./build
pnpm serve          # preview the production build
```

## Brand

Primary color is the Infima `--ifm-color-primary-*` scale in
`src/css/custom.css` (Material Green, `#43A047`). The site font is Google Sans
Flex (OFL). Logo and favicon live in `static/img/`.
