import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const config: Config = {
  title: 'OpenMapX',
  tagline: 'Self-hosted maps, navigation, and transit, built on open data',
  favicon: 'img/favicon.png',

  // Improve compatibility with the upcoming Docusaurus v4.
  future: {
    v4: true,
  },

  url: 'https://docs.openmapx.com',
  baseUrl: '/',

  organizationName: 'OpenMapX',
  projectName: 'openmapx',

  onBrokenLinks: 'throw',

  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          // Docs-only mode: serve documentation from the site root.
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/OpenMapX/openmapx/tree/main/docs/',
          showLastUpdateTime: true,
          showLastUpdateAuthor: true,
          breadcrumbs: true,
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themes: [
    '@docusaurus/theme-mermaid',
    [
      '@easyops-cn/docusaurus-search-local',
      {
        hashed: true,
        indexBlog: false,
        docsRouteBasePath: '/',
        highlightSearchTermsOnTargetPage: true,
      },
    ],
  ],

  themeConfig: {
    image: 'img/openmapx-logo.png',
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'OpenMapX',
      logo: {
        alt: 'OpenMapX',
        src: 'img/openmapx-logo.png',
      },
      items: [
        {
          href: 'https://openmapx.org',
          label: 'Home',
          position: 'right',
        },
        {
          href: 'https://github.com/OpenMapX/openmapx',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'light',
      links: [
        {
          title: 'OpenMapX',
          items: [
            {label: 'Home', href: 'https://openmapx.org'},
            {label: 'Open the map', href: 'https://openmapx.com'},
          ],
        },
        {
          title: 'Project',
          items: [
            {label: 'GitHub', href: 'https://github.com/OpenMapX/openmapx'},
            {label: 'Issues', href: 'https://github.com/OpenMapX/openmapx/issues'},
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} OpenMapX`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'json', 'yaml', 'sql', 'diff', 'nginx', 'docker'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
