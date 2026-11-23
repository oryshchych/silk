'use server';

import { setCartItem } from '@store/core/cart';
import { getCartView } from '@store/core/cart-view';
import { DomainError } from '@store/core/errors';

import { codeFor, RATE_LIMITED, type ActionFailure } from '@/lib/action-result';
import { ensureCartToken, mintCartToken, setCartCount } from '@/lib/cart-cookie';
import { addToCartSchema, cartLineSchema } from '@/lib/checkout-schemas';
import { getDb } from '@/lib/db';
import { errorReason } from '@/lib/error-reason';
import { checkLimit, limiters } from '@/lib/request-limits';

export type CartActionResult = { ok: true; itemCount: number } | ActionFailure;

async function change(
  variantId: string,
  quantity: number,
  mode: 'set' | 'add',
): Promise<CartActionResult> {
  const verdict = await checkLimit(limiters.cart);
  if (!verdict.allowed) {
    return { ok: false, code: RATE_LIMITED, retryAfterSeconds: verdict.retryAfterSeconds };
  }
  const db = await getDb();
  let token = await ensureCartToken();
  try {
    try {
      await db.transaction(async (tx) => {
        await setCartItem(tx, { cartToken: token, variantId, quantity, mode });
      });
    } catch (error) {
      // The cart behind this cookie was already ordered: start a clean one and apply the change.
      if (!(error instanceof DomainError) || error.code !== 'CART_CONVERTED') throw error;
      token = await mintCartToken();
      await db.transaction(async (tx) => {
        await setCartItem(tx, { cartToken: token, variantId, quantity, mode });
      });
    }
    const { itemCount } = await getCartView(db, token, 'uk');
    await setCartCount(itemCount);
    return { ok: true, itemCount };
  } catch (error) {
    if (!(error instanceof DomainError)) {
      process.stderr.write(
        `${JSON.stringify({ level: 'error', scope: 'cart', reason: errorReason(error) })}\n`,
      );
    }
    return { ok: false, code: codeFor(error) };
  }
}

/** Adds units of a variant to the cart. The browser sends a variant id and a quantity, nothing else. */
export async function addToCartAction(input: unknown): Promise<CartActionResult> {
  const parsed = addToCartSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'CART_VARIANT_NOT_FOUND' };
  return await change(parsed.data.variantId, parsed.data.quantity, 'add');
}

/** Sets a line to an exact quantity; 0 removes it. */
export async function setCartLineAction(input: unknown): Promise<CartActionResult> {
  const parsed = cartLineSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'CART_INVALID_QUANTITY' };
  return await change(parsed.data.variantId, parsed.data.quantity, 'set');
}
