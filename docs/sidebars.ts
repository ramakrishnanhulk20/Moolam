import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    'intro',
    {
      type: 'category',
      label: 'Getting Started',
      collapsed: false,
      items: [
        'getting-started/quick-start',
        'getting-started/sign-in-and-account',
        'getting-started/your-first-passport',
      ],
    },
    {
      type: 'category',
      label: 'Concepts',
      collapsed: false,
      items: [
        'concepts/how-it-works',
        'concepts/why-monad',
        'concepts/trust-model',
        'concepts/fingerprints',
      ],
    },
    {
      type: 'category',
      label: 'Guides',
      items: [
        'guides/register-an-image',
        'guides/verify-a-copy',
        'guides/read-a-passport',
        'guides/agents-and-generated-images',
        'guides/edits-and-lineage',
        'guides/disputes',
      ],
    },
    {
      type: 'category',
      label: 'Developers',
      items: [
        'developers/architecture',
        'developers/contracts',
        'developers/verifier-service',
        'developers/chainlink-workflow',
        'developers/envio-indexer',
        'developers/agents-and-privy',
        'developers/prove-it',
      ],
    },
    {
      type: 'category',
      label: 'API Reference',
      items: [
        'api/registry',
        'api/policy-and-receiver',
        'api/events',
        'api/verifier-endpoints',
        'api/graphql',
      ],
    },
    {
      type: 'category',
      label: 'Security',
      items: [
        'security/overview',
        'security/threat-model',
        'security/audits',
      ],
    },
    'faq',
  ],
};

export default sidebars;
