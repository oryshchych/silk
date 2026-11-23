import { sql } from 'drizzle-orm';

import type { DbHandle } from '@store/db/client';

import { setCartItem, startCheckout } from '../src/cart/cart.ts';
import { createOrder } from '../src/orders/create-order.ts';

let seq = 0;

/** Places one order for one unit of a variant (stock is topped up first: the skeleton has one unit). */
export async function placeOrder(
  admin: DbHandle,
  variantId: string,
  provider: 'mono' | 'wayforpay' | 'cod' | 'bank_transfer',
): Promise<string> {
  seq += 1;
  await admin.db.execute(
    sql`UPDATE product_variants SET stock_quantity = 50 WHERE id = ${variantId}`,
  );
  const token = `tok-place-${String(seq)}`.padEnd(20, 'x');
  await admin.db.transaction(async (tx) => {
    await setCartItem(tx, { cartToken: token, variantId, quantity: 1 });
  });
  const intent = await admin.db.transaction(
    async (tx) => await startCheckout(tx, { cartToken: token }),
  );
  const placed = await admin.db.transaction(
    async (tx) =>
      await createOrder(tx, {
        intentId: intent.intentId,
        ownerToken: token,
        contact: { email: 'b@example.com', phone: `+38050222${String(1000 + seq)}`, name: 'Buyer' },
        delivery: { method: 'pickup' },
        paymentProvider: provider,
        promoCode: null,
        locale: 'uk',
        allowUnquoted: true,
        termsAccepted: true,
      }),
  );
  return placed.orderId;
}
