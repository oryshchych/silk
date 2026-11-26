/**
 * The content readiness check and launch gate (phase 9).
 *
 *   DATABASE_URL=postgres://localhost/... pnpm content:check               human summary; exit 1 when the gate fails
 *   DATABASE_URL=... pnpm content:check --gate                            the pre-launch form: verdict and counts only
 *   DATABASE_URL=... pnpm content:check --json                            the full report as JSON on stdout (summary on stderr)
 *   DATABASE_URL=<staging url> pnpm content:check --allow-remote          a database that is not local
 *   ...  --expected-active=40 (default 40)  --report-only (always exit 0)
 *
 * Exit codes: 0 gate passed (or --report-only), 1 gate failed, 2 refused or failed to run.
 *
 * READ ONLY: the report runs inside a `READ ONLY` transaction, so a write is refused by Postgres
 * itself, and the URL comes only from the environment (an argument would end up in the process
 * list). A database that is not local needs `--allow-remote`; one that looks like production is
 * refused even then. NOT wired into CI: an empty staging catalogue would fail every PR.
 */
import {
  assertSafeTarget,
  formatSummary,
  UnsafeTargetError,
} from '../packages/core/src/content-readiness/cli.ts';
import {
  DEFAULT_EXPECTED_ACTIVE,
  readContentReadiness,
} from '../packages/core/src/content-readiness/report.ts';
import { createDb } from '../packages/db/src/client.ts';

const FLAGS = ['--gate', '--json', '--report-only', '--allow-remote'];
const args = process.argv.slice(2);
const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
};

const unknown = args.filter((arg) => !FLAGS.includes(arg) && !arg.startsWith('--expected-active='));
if (unknown.length > 0) fail(`unknown argument: ${unknown.join(' ')}`);
const has = (flag: string): boolean => args.includes(flag);

const expectedArg = args.find((arg) => arg.startsWith('--expected-active='));
const expectedText = expectedArg?.slice('--expected-active='.length);
if (expectedText !== undefined && !/^[0-9]{1,6}$/.test(expectedText))
  fail('--expected-active must be a whole number');
const expectedActive = expectedText === undefined ? DEFAULT_EXPECTED_ACTIVE : Number(expectedText);
if (has('--gate') && expectedActive === 0)
  fail('--gate with --expected-active=0 would pass an empty catalogue');

/** Writes completely before the process may end: a pipe that drains slowly must not cut the JSON. */
const write = async (stream: NodeJS.WriteStream, text: string): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    stream.write(text, (error) => {
      if (error === null || error === undefined) resolve();
      else reject(error);
    });
  });
};

let code = 2;
try {
  // The checker must run with ONLY a database URL: the validated app environment (`@store/shared/env`)
  // demands the whole application configuration, which a content editor's shell does not have.
  /* eslint-disable no-restricted-properties -- see above; same exception as packages/db/src/migrate.ts */
  const url = assertSafeTarget(process.env['DATABASE_URL'], { allowRemote: has('--allow-remote') });
  /* eslint-enable no-restricted-properties */
  const { db, close } = createDb(url.toString(), { max: 1, statementTimeoutMs: 60_000 });
  try {
    const report = await db.transaction(
      async (tx) => await readContentReadiness(tx, { expectedActive }),
      { accessMode: 'read only', isolationLevel: 'repeatable read' },
    );
    const summary = (brief: boolean): string =>
      formatSummary(report, { brief, defaultTarget: expectedText === undefined });
    if (has('--json')) {
      await write(process.stdout, `${JSON.stringify(report)}\n`);
      await write(process.stderr, summary(true));
    } else {
      await write(process.stdout, summary(has('--gate')));
    }
    code = report.gatePassed || has('--report-only') ? 0 : 1;
  } finally {
    await close();
  }
} catch (error) {
  // A stable class and, for the driver, its error code (28P01, ECONNREFUSED ...): never the message,
  // which may carry the host or the user.
  const driverCode =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? ` ${error.code.slice(0, 16)}`
      : '';
  await write(
    process.stderr,
    `${error instanceof UnsafeTargetError ? error.message : `content:check failed: ${error instanceof Error ? error.name : 'error'}${driverCode}`}\n`,
  );
  code = 2;
}
process.exitCode = code;
