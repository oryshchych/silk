import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { AccountForm, type AccountFormKind } from '@/components/account/account-form';
import { SiteShell } from '@/components/site-shell';
import { resolveLocale } from '@/i18n/locale';
import { currentCustomer } from '@/lib/account/session';
import { href, paths } from '@/lib/paths';

const PATH: Record<AccountFormKind, string> = {
  login: paths.accountLogin,
  register: paths.accountRegister,
  forgot: paths.accountForgot,
  setPassword: paths.accountSetPassword,
};

type LinkKey = 'registerLink' | 'forgotLink' | 'loginLink';

const TITLE = {
  login: 'loginTitle',
  register: 'registerTitle',
  forgot: 'forgotTitle',
  setPassword: 'setPasswordTitle',
} as const;
const INTRO = {
  login: 'loginIntro',
  register: 'registerIntro',
  forgot: 'forgotIntro',
  setPassword: 'setPasswordIntro',
} as const;

const LINKS: Record<AccountFormKind, { path: string; key: LinkKey }[]> = {
  login: [
    { path: paths.accountRegister, key: 'registerLink' },
    { path: paths.accountForgot, key: 'forgotLink' },
  ],
  register: [{ path: paths.accountLogin, key: 'loginLink' }],
  forgot: [{ path: paths.accountLogin, key: 'loginLink' }],
  setPassword: [],
};

/**
 * One credential page (sign in, register, forgot, set password): locale, title, the form, and a
 * redirect to the account for someone already signed in. Rendered per request, never cached.
 * `token` is the mailed link's token; it is shown to nobody and only passed to the form's POST.
 */
export async function CredentialPage({
  rawLocale,
  kind,
  notice = false,
  token,
}: {
  rawLocale: string;
  kind: AccountFormKind;
  notice?: boolean;
  token?: string | undefined;
}) {
  const { locale, known } = resolveLocale(rawLocale);
  if (!known) notFound();
  if ((await currentCustomer()) !== null) redirect(href(locale, paths.account));
  const t = await getTranslations('account');
  const linkInvalid = kind === 'setPassword' && (token === undefined || token === '');
  return (
    <SiteShell locale={locale} path={PATH[kind]} degrade>
      <h1 className="font-display text-3xl">{t(TITLE[kind])}</h1>
      {notice ? (
        <p role="status" className="mt-2">
          {t('passwordSet')}
        </p>
      ) : null}
      <p className="mb-6 mt-2 text-text-muted">{t(INTRO[kind])}</p>
      {linkInvalid ? (
        <p role="alert" className="text-danger">
          {t('error.invalid')}
        </p>
      ) : (
        <AccountForm kind={kind} locale={locale} token={token} />
      )}
      <ul className="mt-6 flex flex-col gap-1 text-sm">
        {LINKS[kind].map((link) => (
          <li key={link.path}>
            <Link
              href={href(locale, link.path)}
              className="inline-flex min-h-6 items-center underline"
            >
              {t(link.key)}
            </Link>
          </li>
        ))}
      </ul>
    </SiteShell>
  );
}
