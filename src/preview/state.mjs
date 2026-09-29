export function previewState() {
  return {
    product: 'BIZNORYX',
    releaseState: 'controlled_beta_ready',
    productionTruth: {
      status: 'not_public_production_launched',
      reason: 'Real production infrastructure, secrets, provider deployment, customer contracts, and external audits are outside this local repository.'
    },
    business: {
      name: 'Acme Retail Group',
      period: 'March 2027',
      pulse: 'Revenue improved for the third consecutive month while data health remains ready.',
      modules: [
        'Business Pulse',
        'KPI Scoreboard',
        'Historical Trends',
        'Risks',
        'Opportunities',
        'Actions',
        'Forecasts',
        'Enterprise Scaling',
        'Launch Readiness'
      ]
    },
    kpis: [
      { label: 'Revenue', value: '$120,000', trend: '+9.1%', status: 'verified' },
      { label: 'Orders', value: '2,410', trend: '+5.4%', status: 'verified' },
      { label: 'Average Order Value', value: '$49.79', trend: '+3.2%', status: 'verified' },
      { label: 'Rejected Data Runs', value: '0', trend: 'healthy', status: 'verified' }
    ],
    findings: [
      { kind: 'Opportunity', title: 'Store channel momentum continued', evidence: 'Verified revenue moved from 110000 to 120000 across recurring monthly periods.' },
      { kind: 'Risk', title: 'Forecast confidence remains basic', evidence: 'Linear projection is available, but seasonal model depth is not yet implemented.' },
      { kind: 'Recommendation', title: 'Track March campaign follow-through', evidence: 'Action/outcome workflow is ready to connect actions to later verified metric movement.' }
    ],
    actions: [
      { title: 'Review top products behind March lift', owner: 'Operations', status: 'in_progress' },
      { title: 'Confirm next-period revenue target', owner: 'Founder', status: 'planned' }
    ],
    forecasts: [
      { scenario: 'Expansion case', horizon: '3 months', values: ['$143,000', '$154,000', '$165,000'], readiness: 'calculated_from_verified_history' }
    ],
    gates: [
      { name: 'Product foundation', command: 'npm run verify', state: 'passed', evidence: '93/93 tests passed in latest verification.' },
      { name: 'Database isolation', command: 'npm run db:acceptance', state: 'passed', evidence: 'PostgreSQL RLS acceptance passed from a clean database.' },
      { name: 'Release readiness', command: 'npm run release:check', state: 'conditional', evidence: 'Passes only with real production-shaped environment variables.' },
      { name: 'Deployment readiness', command: 'npm run deploy:check', state: 'conditional', evidence: 'Passes only after release and database readiness flags are set.' },
      { name: 'Compliance readiness', command: 'npm run compliance:check', state: 'conditional', evidence: 'Passes only after evidence review is explicitly approved.' },
      { name: 'Beta launch handoff', command: 'npm run launch:check', state: 'conditional', evidence: 'Passes only after release, deployment, compliance, and final approval flags are set.' }
    ],
    nextWork: [
      'Build the real authenticated web app shell with routes and persistent API/database adapters.',
      'Provision production infrastructure and managed secrets with a chosen provider.',
      'Connect real customer onboarding flows and file/API ingestion UI.',
      'Complete external compliance audit work if certification is required.'
    ]
  };
}
