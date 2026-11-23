import { randomBytes } from 'node:crypto';

import { cookies } from 'next/headers';

import { CART_COUNT_COOKIE } from './cart-events';
import { runtimeEnv } from './runtime-env';

/**
 * The guest cart token is the credential of a cart and its checkout intents:
 * server-minted, 192 bits, in an httpOnly cookie. `SameSite=Lax` (not Strict) so
 * a buyer coming back from a payment page or an email link is still recognised;
 * the actions that change state are POSTs, which Lax does not send cross-site.
 * The order cookie holds the access token of the last order for its page.
 */
const CART = 'silk_cart';
const ORDER = 'silk_order';
/** Order page access: a day, not a month, so a shared computer does not keep showing the address. */
const ONE_DAY = 24 * 60 * 60;
const CART_TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const THIRTY_DAYS = 30 * 24 * 60 * 60;

const COUNT = CART_COUNT_COOKIE;

const secure = async (): Promise<boolean> => (await runtimeEnv()).APP_ENV !== 'local';

const base = { httpOnly: true, sameSite: 'lax', path: '/' } as const;

/**
 * Over HTTPS the credential cookies carry the `__Host-` prefix: the browser then refuses to let a
 * sibling subdomain set or overwrite them (cookie tossing / cart fixation), because the prefix
 * demands Secure, Path=/ and no Domain. Over plain HTTP (local) the prefix would be rejected.
 */
const nameOf = async (name: string): Promise<string> =>
  (await secure()) ? `__Host-${name}` : name;

/** The token of the visitor's cart, or null for a visitor without one (or with a malformed value). */
export async function readCartToken(): Promise<string | null> {
  const value = (await cookies()).get(await nameOf(CART))?.value;
  return value !== undefined && CART_TOKEN.test(value) ? value : null;
}

/** Existing token, or a new one set on the response. Only callable from a server action or route handler. */
export async function ensureCartToken(): Promise<string> {
  const existing = await readCartToken();
  if (existing !== null) return existing;
  return await mintCartToken();
}

/** Fresh token: after an order the old cart is converted and must not be reused. */
export async function mintCartToken(): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  (await cookies()).set(await nameOf(CART), token, {
    ...base,
    maxAge: THIRTY_DAYS,
    secure: await secure(),
  });
  return token;
}

/** The count is not a secret: it is readable by the page script to show the header badge. */
export async function setCartCount(count: number): Promise<void> {
  (await cookies()).set(COUNT, String(Math.max(0, Math.min(count, 9999))), {
    httpOnly: false,
    sameSite: 'lax',
    path: '/',
    maxAge: THIRTY_DAYS,
    secure: await secure(),
  });
}

export async function setOrderAccess(orderNumber: string, accessToken: string): Promise<void> {
  (await cookies()).set(await nameOf(ORDER), `${orderNumber}.${accessToken}`, {
    ...base,
    maxAge: ONE_DAY,
    secure: await secure(),
  });
}

/** Order number and access token of the last order placed in this browser, or null. */
export async function readOrderAccess(): Promise<{ orderNumber: string; token: string } | null> {
  const value = (await cookies()).get(await nameOf(ORDER))?.value;
  const dot = value?.indexOf('.') ?? -1;
  if (value === undefined || dot < 1) return null;
  return { orderNumber: value.slice(0, dot), token: value.slice(dot + 1) };
}
