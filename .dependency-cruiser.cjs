// Межі архітектури як перевірка, а не як домовленість.
// Головне правило (AGENTS.md §2.3): packages/core не знає про Next.js.
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Циклічна залежність. Розірвати, а не обійти.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'core-no-next',
      severity: 'error',
      comment:
        'packages/core не імпортує Next.js: домен приймає транзакцію й аргументи, ' +
        'не знає про HTTP (AGENTS.md §2.3).',
      from: { path: '^packages/core' },
      to: { dependencyTypes: ['npm'], path: '^next(/|$)' },
    },
    {
      name: 'core-no-apps',
      severity: 'error',
      comment: 'Залежність домену від застосунку — інверсія шарів.',
      from: { path: '^packages/core' },
      to: { path: '^apps' },
    },
    {
      name: 'packages-no-next-cache',
      severity: 'error',
      comment: 'revalidateTag живе в apps/web. Воркер інвалідує через outbox (ADR-8).',
      from: { path: '^packages' },
      to: { dependencyTypes: ['npm'], path: '^next/cache' },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$',
          // Точки входу інструментів: їх імпортує CLI, а не наш код.
          '(^|/)drizzle\\.config\\.ts$',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(node_modules|\\.next|dist|coverage|\\.turbo)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'types'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
