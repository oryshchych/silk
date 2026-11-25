'use server';

import { cookies } from 'next/headers';

import { cookiesAreSecure } from '@/lib/admin/config';
import { requestOriginOk } from '@/lib/admin/bound-action';
import { preferenceCookieOptions } from '@/lib/admin/cookies';
import { LOCALE_COOKIE, THEME_COOKIE, parseAdminLocale, parseTheme } from '@/lib/admin/preferences';

/**
 * Theme and language of the admin. Cosmetic cookies scoped to `/admin`: no session needed, but the
 * Origin is still checked, and a value outside the known list is replaced by the default (it is
 * never stored as sent).
 */
export async function setThemeAction(form: FormData): Promise<void> {
  if (!(await requestOriginOk())) return;
  const raw = form.get('theme');
  (await cookies()).set(
    THEME_COOKIE,
    parseTheme(typeof raw === 'string' ? raw : null),
    preferenceCookieOptions(await cookiesAreSecure()),
  );
}

export async function setLocaleAction(form: FormData): Promise<void> {
  if (!(await requestOriginOk())) return;
  const raw = form.get('locale');
  (await cookies()).set(
    LOCALE_COOKIE,
    parseAdminLocale(typeof raw === 'string' ? raw : null),
    preferenceCookieOptions(await cookiesAreSecure()),
  );
}
