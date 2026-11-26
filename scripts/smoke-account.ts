/**
 * The customer account on the BUILT app over real HTTP (called from smoke-web.ts): the credential
 * pages and their headers, registration by link, the one-time link, sign-in, the session cookie,
 * sign-out, enumeration-safe answers, the Origin check and the per-client limits. No browser: server
 * actions are POSTed with the `Next-Action` id from the build's manifest, as the page script does.
 * The mailed link is rebuilt from the token id in the database, exactly as the worker does (nothing
 * is sent anywhere).
 */
import { buildEmailToken } from '../packages/core/src/customer-auth/tokens.ts';
import { createDb } from '../packages/db/src/client.ts';
import { absorb, actionIds, cookieHeader, type Jar } from './smoke-http.ts';

interface Context {
  base: string;
  databaseUrl: string;
  authSecret: string;
  buildRoot: string;
  siteOrigin: string;
  check: (name: string, ok: boolean) => void;
}

const PASSWORD = 'smoke-customer-password-91';

export async function runAccountSmoke(ctx: Context): Promise<void> {
  const { base, siteOrigin } = ctx;
  /** A failed check prints what the server answered, so a CI log is enough to see why. */
  const check = (name: string, ok: boolean, detail?: unknown): void => {
    ctx.check(name, ok);
    if (!ok && detail !== undefined) {
      process.stdout.write(`     ${JSON.stringify(detail).slice(0, 700)}\n`);
    }
  };
  const brief = (r: {
    status?: number;
    location?: string | null;
    redirect?: string | null;
    cache?: string;
    setCookie?: string;
    body?: string;
    html?: string;
  }) => ({
    status: r.status,
    location: r.location,
    redirect: r.redirect,
    cache: r.cache,
    setCookie: r.setCookie,
    text: (r.body ?? r.html ?? '').slice(0, 300),
  });
  const ids = actionIds(ctx.buildRoot);
  const handle = createDb(ctx.databaseUrl, { max: 2 });
  let clientCounter = 0;
  const newClient = (): string => `203.0.113.${String(100 + ++clientCounter)}`;
  const stamp = String(Date.now()).slice(-8);

  const page = async (path: string, jar: Jar = new Map(), client = newClient()) => {
    const response = await fetch(base + path, {
      redirect: 'manual',
      headers: { Cookie: cookieHeader(jar), 'X-Forwarded-For': client },
    });
    return {
      status: response.status,
      location: response.headers.get('location'),
      cache: response.headers.get('cache-control') ?? '',
      robots: response.headers.get('x-robots-tag') ?? '',
      referrer: response.headers.get('referrer-policy') ?? '',
      html: await response.text(),
    };
  };

  async function act(
    name: string,
    args: Record<string, unknown>,
    jar: Jar,
    client: string,
    path = '/account/login',
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(base + path, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Next-Action': ids[name] ?? '',
        'Content-Type': 'text/plain;charset=UTF-8',
        'X-Forwarded-For': client,
        Origin: siteOrigin,
        'X-Forwarded-Host': new URL(siteOrigin).host,
        Cookie: cookieHeader(jar),
        ...headers,
      },
      body: JSON.stringify([args]),
    });
    absorb(jar, response);
    return {
      status: response.status,
      redirect: response.headers.get('x-action-redirect'),
      setCookie: response.headers.getSetCookie().join('\n'),
      body: await response.text(),
    };
  }

  /** The link the worker would mail: rebuilt from the newest open token of the address. */
  async function mailedToken(email: string): Promise<string> {
    const { rows } = await handle.pool.query<{ id: string }>(
      `SELECT t.id FROM auth_email_tokens t JOIN auth_users u ON u.id = t.user_id
        WHERE u.email = $1 ORDER BY t.created_at DESC LIMIT 1`,
      [email],
    );
    const row = rows[0];
    return buildEmailToken(ctx.authSecret, row?.id ?? '');
  }

  try {
    // 1. The pages: a person's answers are never stored, never indexed, and the link page sends no referrer.
    for (const path of ['/account/login', '/en/account/register', '/account/forgot']) {
      const response = await page(path);
      check(
        `${path} is 200 with no-store, noindex and a form`,
        response.status === 200 &&
          response.cache.includes('no-store') &&
          response.robots.includes('noindex') &&
          response.html.includes('<form'),
      );
    }
    const link = await page('/account/set-password?t=garbage');
    check(
      'the link page opens without using the token and sends no referrer',
      link.status === 200 && link.referrer === 'no-referrer' && link.html.includes('<form'),
    );
    const noToken = await page('/account/set-password');
    check(
      'the link page without a token shows the refusal and no form',
      noToken.status === 200 && !noToken.html.includes('type="password"'),
    );
    const anonymous = await page('/account');
    check(
      '/account without a session redirects to the sign-in page (no account data)',
      anonymous.status >= 300 &&
        anonymous.status < 400 &&
        (anonymous.location ?? '').includes('/account/login'),
      brief(anonymous),
    );
    const english = await page('/en/account');
    check(
      '/en/account redirects to the English sign-in page',
      (english.location ?? '').includes('/en/account/login'),
      brief(english),
    );
    const home = await page('/');
    check(
      'the storefront header links to the account with no per-visitor markup',
      home.status === 200 && home.html.includes('href="/account"'),
      brief(home),
    );

    // 2. Registration is the same answer for a new and an existing address (no enumeration).
    const email = `smoke-${stamp}@example.test`;
    const jar: Jar = new Map();
    const first = await act(
      'registerAction',
      { email, locale: 'uk' },
      jar,
      newClient(),
      '/account/register',
    );
    const again = await act(
      'registerAction',
      { email, locale: 'uk' },
      jar,
      newClient(),
      '/account/register',
    );
    const garbage = await act(
      'registerAction',
      { email: 'nope', locale: 'uk' },
      jar,
      newClient(),
      '/account/register',
    );
    check(
      'register: a new address and a repeated one answer "sent"',
      first.body.includes('"status":"sent"') && again.body.includes('"status":"sent"'),
    );
    check(
      'register: garbage is an invalid-input error, nothing is sent',
      garbage.body.includes('"code":"invalid"'),
      brief(garbage),
    );
    const foreign = await act(
      'registerAction',
      { email: `x-${stamp}@example.test`, locale: 'uk' },
      jar,
      newClient(),
      '/account/register',
      { Origin: 'https://evil.example', 'X-Forwarded-Host': 'evil.example' },
    );
    check('register: a foreign Origin is refused', foreign.body.includes('"status":"error"'));

    // 3. Nobody signs in before the link is used; a forged link and a weak password change nothing.
    const early = await act(
      'customerLoginAction',
      { email, password: PASSWORD, locale: 'uk' },
      new Map(),
      newClient(),
    );
    check(
      'sign-in before the link is used is refused',
      early.redirect === null && early.body.includes('"code":"invalid"'),
    );
    const token = await mailedToken(email);
    const forged = await act(
      'setPasswordAction',
      { token: `${token.slice(0, -2)}AA`, password: PASSWORD, locale: 'uk' },
      new Map(),
      newClient(),
      '/account/set-password',
    );
    check(
      'a forged link is refused',
      forged.redirect === null && forged.body.includes('"code":"invalid"'),
    );
    const weak = await act(
      'setPasswordAction',
      { token, password: 'short', locale: 'uk' },
      new Map(),
      newClient(),
      '/account/set-password',
    );
    check('a weak password is refused without using the link', weak.body.includes('"code":"weak"'));
    const done = await act(
      'setPasswordAction',
      { token, password: PASSWORD, locale: 'uk' },
      new Map(),
      newClient(),
      '/account/set-password',
    );
    check(
      'the link sets the password and sends the person to sign in',
      (done.redirect ?? '').includes('/account/login?done=1'),
    );
    const replay = await act(
      'setPasswordAction',
      { token, password: 'another-password-77', locale: 'uk' },
      new Map(),
      newClient(),
      '/account/set-password',
    );
    check(
      'REPLAY: the same link twice is refused',
      replay.redirect === null && replay.body.includes('"code":"invalid"'),
    );

    // 4. Sign in: the cookie is HttpOnly, Lax and Secure on the production-like server; the page shows the account.
    const session: Jar = new Map();
    const bad = await act(
      'customerLoginAction',
      { email, password: 'wrong-password-xx', locale: 'uk' },
      new Map(),
      newClient(),
    );
    check(
      'a wrong password is the generic refusal',
      bad.redirect === null && bad.body.includes('"code":"invalid"'),
    );
    const signedIn = await act(
      'customerLoginAction',
      { email, password: PASSWORD, locale: 'uk' },
      session,
      newClient(),
    );
    check(
      'sign-in redirects to the account and sets an HttpOnly, SameSite=Lax, Secure cookie',
      (signedIn.redirect ?? '').startsWith('/account') &&
        /customer_session=[^;]+;.*HttpOnly/i.test(signedIn.setCookie) &&
        /SameSite=lax/i.test(signedIn.setCookie) &&
        /Secure/i.test(signedIn.setCookie),
      brief(signedIn),
    );
    const shop = await page('/', session);
    check(
      'the storefront answers a signed-in visitor with the same page: no address, no account state',
      shop.status === 200 && !shop.html.includes(email),
      brief(shop),
    );
    const mine = await page('/account', session);
    check(
      '/account shows the signed-in address, no-store and noindex',
      mine.status === 200 &&
        mine.html.includes(email) &&
        mine.cache.includes('no-store') &&
        mine.robots.includes('noindex'),
    );
    const forgedPage = await page(
      '/account',
      new Map([['customer_session', 'v1.00000000-0000-4000-8000-000000000000.9999999999.AAAA']]),
    );
    check('a forged cookie is no session', forgedPage.status !== 200, brief(forgedPage));
    const crossed = await page(
      '/admin',
      new Map([['admin_session', session.get('customer_session') ?? '']]),
    );
    check(
      'WALL: the customer cookie as an admin cookie opens nothing of the admin',
      !crossed.html.includes('admin-shell') && crossed.status !== 200,
    );

    // 5. Sign out ends the session on the server, not only in the browser.
    const stale = new Map(session);
    await act('customerLogoutAction', { locale: 'uk' }, session, newClient(), '/account');
    const afterOut = await page('/account', stale);
    check(
      'after sign-out the old cookie is no session (no address on the page)',
      !afterOut.html.includes(email) && afterOut.html.includes('/account/login'),
      brief(afterOut),
    );

    // 6. Limits: mails and sign-in attempts from one client run out.
    const hammer = newClient();
    let mailLimited = false;
    for (let i = 0; i < 8; i += 1) {
      const result = await act(
        'forgotPasswordAction',
        { email: `limit-${stamp}-${String(i)}@example.test`, locale: 'uk' },
        new Map(),
        hammer,
        '/account/forgot',
      );
      if (result.body.includes('"code":"rateLimited"') || result.status === 429) mailLimited = true;
    }
    check('mail requests from one client are rate limited', mailLimited);
    const guesser = newClient();
    let loginLimited = false;
    for (let i = 0; i < 14; i += 1) {
      const result = await act(
        'customerLoginAction',
        { email: `nobody-${stamp}@example.test`, password: 'wrong-password-xx', locale: 'uk' },
        new Map(),
        guesser,
      );
      if (result.body.includes('"code":"rateLimited"') || result.status === 429)
        loginLimited = true;
    }
    check('sign-in attempts from one client are rate limited', loginLimited);
  } finally {
    await handle.close();
  }
}
