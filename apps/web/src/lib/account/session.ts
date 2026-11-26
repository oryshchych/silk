import { resolveCustomerSession, type CustomerSession } from '@store/core/customer-session';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import type { SiteLocale } from '@store/shared/seo';

import { authConfig, cookiesAreSecure } from '../admin/config';
import { getDb } from '../db';
import { href } from '../paths';
import { customerCookieName } from './cookies';

/** The customer of this request, read from the database (never trusted from the cookie), or null. */
export async function currentCustomer(): Promise<CustomerSession | null> {
  const token = (await cookies()).get(customerCookieName(await cookiesAreSecure()))?.value;
  if (token === undefined) return null;
  return await resolveCustomerSession(await getDb(), await authConfig(), token);
}

/** A page of the account: the signed-in customer or a redirect to the sign-in page. */
export async function requireCustomer(locale: SiteLocale): Promise<CustomerSession> {
  const customer = await currentCustomer();
  if (customer === null) redirect(href(locale, '/account/login'));
  return customer;
}
