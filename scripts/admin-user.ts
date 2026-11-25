/**
 * Admin accounts from the command line (there is no public sign-up and no user screen yet).
 *
 *   pnpm admin:seed-local                       a local owner for development (refuses anything but APP_ENV=local)
 *   pnpm admin:unlock --email=a@b.c             lifts a lockout (the owner's recovery; audited)
 *   printf %s "$PASSWORD" | pnpm admin:create --email=a@b.c --role=owner|admin|manager|content
 *
 * The password of `admin:create` is read from standard input (never from an argument, which ends
 * up in the shell history and the process list). The local owner's credentials below are TEST
 * values for a developer's own machine; they are refused outside APP_ENV=local.
 */
// Relative imports: the repository root does not depend on the workspace packages.
import {
  adminUserExists,
  createAdminUser,
  unlockAccount,
} from '../packages/core/src/auth/service.ts';
import { ROLES, type AdminRole } from '../packages/core/src/auth/permissions.ts';
import { createDb } from '../packages/db/src/client.ts';
import { env } from '../packages/shared/src/env.server.ts';

const LOCAL_OWNER = { email: 'owner@example.test', password: 'local-dev-password-1234' };

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const command = process.argv[2];
const { db, close } = createDb(env.DATABASE_URL, { max: 1 });
try {
  if (command === 'seed-local') {
    if (env.APP_ENV !== 'local') throw new Error('seed-local runs only with APP_ENV=local');
    if (await adminUserExists(db, LOCAL_OWNER.email)) {
      process.stdout.write(`${LOCAL_OWNER.email} already exists\n`);
    } else {
      await db.transaction(async (tx) => {
        await createAdminUser(tx, { ...LOCAL_OWNER, role: 'owner' });
      });
      process.stdout.write(
        `created ${LOCAL_OWNER.email} (owner); sign in at /admin/login, set up TOTP on first login\n`,
      );
    }
  } else if (command === 'create') {
    const email = argument('email');
    const role = ROLES.find((candidate): candidate is AdminRole => candidate === argument('role'));
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
    const password = Buffer.concat(chunks)
      .toString('utf8')
      .replace(/\r?\n$/, '');
    if (email === undefined || role === undefined || password === '') {
      throw new Error('usage: printf %s "$PASSWORD" | admin-user.ts create --email=... --role=...');
    }
    await db.transaction(async (tx) => {
      await createAdminUser(tx, { email, password, role });
    });
    process.stdout.write(`created ${email} (${role})\n`);
  } else if (command === 'unlock') {
    const email = argument('email');
    if (email === undefined) throw new Error('usage: admin-user.ts unlock --email=...');
    const found = await db.transaction(async (tx) => await unlockAccount(tx, { email }));
    process.stdout.write(found ? `unlocked ${email}\n` : 'no such account\n');
  } else {
    throw new Error(
      'usage: admin-user.ts seed-local | create --email=... --role=... | unlock --email=...',
    );
  }
} finally {
  await close();
}
