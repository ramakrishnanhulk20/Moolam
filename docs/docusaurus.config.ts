import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const GITHUB_URL = 'https://github.com/ramakrishnanhulk20/Moolam';

const config: Config = {
  title: 'Moolam',
  tagline: 'A passport for every AI-generated image, on Monad',
  favicon: 'img/favicon.svg',

  url: 'https://moolam-docs.vercel.app',
  baseUrl: '/',
  trailingSlash: false,

  organizationName: 'ramakrishnanhulk20',
  projectName: 'Moolam',

  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',

  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },
  themes: ['@docusaurus/theme-mermaid'],

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
          // The attack transcripts are assets the security pages link to, not pages
          // of their own, so the folder is kept out of doc discovery.
          exclude: ['**/security/attacks/**'],
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      defaultMode: 'dark',
      respectPrefersColorScheme: false,
    },
    navbar: {
      // The lockup carries the word, so a title next to it would set Moolam twice.
      logo: {
        alt: 'Moolam',
        src: 'img/logo-light.svg',
        srcDark: 'img/logo.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          href: GITHUB_URL,
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        { label: 'Docs', to: '/' },
        { label: 'GitHub', href: GITHUB_URL },
        { label: 'Monad', href: 'https://www.monad.xyz' },
      ],
      copyright: `Moolam ${new Date().getFullYear()}`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['solidity', 'bash', 'json', 'graphql', 'yaml'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
