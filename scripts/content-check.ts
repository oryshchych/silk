/**
 * The content readiness check and launch gate (phase 9).
 *
 *   DATABASE_URL=postgres://... pnpm content:check                 human summary; exit 1 when the gate fails
 *   DATABASE_URL=postgres://... pnpm content:check --gate          the pre-launch form: verdict and counts only
 *   DATABASE_URL=postgres://... pnpm content:check --json          the full report as JSON on stdout (summary on stderr)
 *   ...                        --expected-active=40 --report-only (always exit 0)
 *
 * Exit codes: 0 gate passed (or --report-only), 1 gate failed, 2 refused or failed to run.
 *
 * READ ONLY: the report runs inside a `READ ONLY` transaction, so a write is refused by Postgres
 * itself, and the URL comes only from the environment (an argument would end up in the process
 * list). A URL that looks like production is refused unless the process runs with
 * APP_ENV=production. It is NOT wired into CI: an empty staging catalogue would fail every PR.
 */
import {
  assertSafeTarget,
  formatSummary,
  UnsafeTargetError,
} from '../packages/core/src/content-readiness/cli.ts';
import { readContentReadiness } from '../packages/core/src/content-readiness/read.ts';
import { createDb } from '../packages/db/src/client.ts';

const flags = new Set(process.argv.slice(2).filter((arg) => !arg.includes('=')));
const expectedText = process.argv
  .slice(2)
  .find((arg) => arg.startsWith('--expected-active='))
  ?.slice('--expected-active='.length);
const expectedActive = expectedText === undefined ? undefined : Number(expectedText);
if (expectedActive !== undefined && (!Number.isInteger(expectedActive) || expectedActive < 0)) {
  process.stderr.write('--expected-active must be a whole number\n');
  process.exit(2);
}
const unknown = process.argv
  .slice(2)
  .filter(
    (arg) =>
      !['--gate', '--json', '--report-only'].includes(arg) && !arg.startsWith('--expected-active='),
  );
if (unknown.length > 0) {
  process.stderr.write(`unknown argument: ${unknown.join(' ')}\n`);
  process.exit(2);
}

let code = 2;
try {
  // The checker must run with ONLY a database URL: the validated app environment (`@store/shared/env`)
  // demands the whole application configuration, which a content editor's shell does not have.
  /* eslint-disable no-restricted-properties -- see above; same exception as packages/db/src/migrate.ts */
  const url = assertSafeTarget(process.env['DATABASE_URL'], process.env['APP_ENV']);
  /* eslint-enable no-restricted-properties */
  const { db, close } = createDb(url.toString(), { max: 1, statementTimeoutMs: 60_000 });
  try {
    const report = await db.transaction(
      async (tx) =>
        await readContentReadiness(tx, expectedActive === undefined ? {} : { expectedActive }),
      { accessMode: 'read only', isolationLevel: 'repeatable read' },
    );
    if (flags.has('--json')) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
      process.stderr.write(formatSummary(report, { brief: true }));
    } else {
      process.stdout.write(formatSummary(report, { brief: flags.has('--gate') }));
    }
    code = report.gatePassed || flags.has('--report-only') ? 0 : 1;
  } finally {
    await close();
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof UnsafeTargetError ? error.message : `content:check failed: ${error instanceof Error ? error.name : 'error'}`}\n`,
  );
  code = 2;
}
process.exit(code);
