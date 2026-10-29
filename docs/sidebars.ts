import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    {
      type: 'category',
      label: 'Start here',
      collapsed: false,
      items: [
        'overview/introduction',
        'overview/using-openmapx',
        'overview/how-it-works',
        'overview/troubleshooting',
      ],
    },
    {
      type: 'category',
      label: 'Using OpenMapX',
      collapsed: true,
      items: [
        {
          type: 'category',
          label: 'Find and save places',
          collapsed: true,
          items: [
            'features/search',
            'features/natural-language-search',
            'features/places',
            'features/saved-places',
            'features/accounts-and-privacy',
            'features/reviews',
            'features/osm-contributions',
            'features/overture-places',
          ],
        },
        {
          type: 'category',
          label: 'Travel and navigation',
          collapsed: true,
          items: [
            'features/directions',
            'features/public-transit',
            'features/vehicles-and-parking',
            'features/offline-maps',
            'features/personal-timeline',
          ],
        },
        {
          type: 'category',
          label: 'Explore the map',
          collapsed: true,
          items: [
            'features/map-layers',
            'features/map-framing',
            'features/schematic-transit-map',
            'features/street-level-imagery',
            'features/mobility-data',
            'features/weather',
            'features/crowd-reports',
          ],
        },
        {
          type: 'category',
          label: 'Air quality',
          collapsed: true,
          items: [
            'features/air-quality',
            'features/air-quality-map',
            'features/air-quality-uk-air',
            'features/air-quality-eccc',
          ],
        },
      ],
    },
    {
      type: 'category',
      label: 'Self-hosting',
      collapsed: true,
      items: [
        'install/getting-started',
        'install/configuration',
        'install/managing-services',
        'install/preparing-data',
        'install/upgrading',
        'developer/cli-reference',
        {
          type: 'category',
          label: 'Choose and configure backends',
          collapsed: true,
          items: [
            'guides/routing-engines',
            'guides/geocoders',
            'guides/transit-engines',
            'guides/map-tiles',
            'guides/osm-data-queries',
            'guides/supporting-infrastructure',
            'guides/dawarich',
            'guides/cost-optimization',
          ],
        },
      ],
      link: {
        type: 'doc',
        id: 'install/requirements',
      },
    },
    {
      type: 'category',
      label: 'Administration',
      collapsed: true,
      items: [
        {
          type: 'category',
          label: 'Services and providers',
          collapsed: true,
          items: [
            'administration/services-administration',
            'administration/integrations-administration',
            'administration/community-extensions',
          ],
        },
        {
          type: 'category',
          label: 'Accounts and data',
          collapsed: true,
          items: [
            'administration/users-and-access',
            'administration/backup-and-restore',
            'administration/data-subject-requests',
            'administration/user-erasure',
          ],
        },
        {
          type: 'category',
          label: 'Health and coverage',
          collapsed: true,
          items: [
            'administration/monitoring',
            'administration/coverage-freshness',
            'administration/transit-reachability',
            'administration/motis-operations-profiles',
            'administration/air-quality-eea-data-use',
          ],
        },
      ],
      link: {
        type: 'doc',
        id: 'administration/admin-panel',
      },
    },
    {
      type: 'category',
      label: 'Development',
      collapsed: true,
      items: [
        {
          type: 'category',
          label: 'Architecture and contracts',
          collapsed: true,
          items: [
            'developer/architecture',
            'developer/integration-system',
            'developer/api-surface',
            'developer/service-manifest',
            'developer/user-data-trust-model',
            'developer/user-data-confidentiality-architecture',
          ],
        },
        {
          type: 'category',
          label: 'Build integrations',
          collapsed: true,
          items: [
            'developer/writing-an-integration',
            'developer/building-an-external-extension',
            'developer/transit-integrations',
            'developer/ride-integrations',
            'developer/data-source-integrations',
            'developer/entur-geocoder',
            'developer/osm-contributions',
          ],
        },
        {
          type: 'category',
          label: 'Air-quality providers',
          collapsed: true,
          items: [
            'developer/air-quality-integrations',
            'developer/air-quality-monitor-api',
            'developer/air-quality-eea-ground',
            'developer/air-quality-uk-air',
            'developer/air-quality-eccc',
          ],
        },
        {
          type: 'category',
          label: 'Search and map engineering',
          collapsed: true,
          items: [
            'developer/natural-language-search',
            'developer/discovery-evaluation',
            'developer/business-name-address-retrieval',
            'developer/ambient-places-publication',
            'developer/map-comparison-baseline',
            'developer/navigation-performance',
            'developer/offline-maps',
          ],
        },
        {
          type: 'category',
          label: 'Mobile app',
          collapsed: true,
          items: [
            'developer/mobile-architecture',
            'developer/mobile-feasibility',
            'developer/mobile-release',
            'developer/mobile-store-operations',
          ],
        },
        {
          type: 'category',
          label: 'Contributing and releases',
          collapsed: true,
          items: [
            'developer/contributing-process',
            'developer/documentation',
            'developer/licensing',
            'developer/ci-performance',
            'developer/repository-governance',
            'developer/package-releases',
            'developer/product-releases',
            'developer/self-hosting-replay',
          ],
        },
      ],
      link: {
        type: 'doc',
        id: 'developer/development-setup',
      },
    },
    {
      type: 'category',
      label: 'Release notes',
      collapsed: true,
      items: [
        'releases/0.1.0-alpha.1',
      ],
    },
  ],
};

export default sidebars;
