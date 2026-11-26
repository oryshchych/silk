'use server';

import { cookies } from 'next/headers';
import { refresh } from 'next/cache';
import { z } from 'zod';

import { addAddress, addressInputSchema, deleteAddress } from '@store/core/account-addresses';
import { reorderMyOrder } from '@store/core/account-orders';
import {
  mySizeLabels,
  setMySizes,
  setNewsletter,
  SizeNotFoundError,
  updateProfile,
  updateProfileSchema,
} from '@store/core/account-profile';

import { customerAction, type CustomerActionResult } from '@/lib/account/action';
import { ensureCartToken } from '@/lib/cart-cookie';
import { cookiesAreSecure } from '@/lib/admin/config';
import { formatSizesCookie, SIZES_COOKIE } from '@/lib/my-sizes';

const THIRTY_DAYS = 60 * 60 * 24 * 30;

async function writeSizesCookie(sizes: {
  bra: string | null;
  apparel: string | null;
}): Promise<void> {
  const store = await cookies();
  if (sizes.bra === null && sizes.apparel === null) {
    store.delete({ name: SIZES_COOKIE, path: '/' });
    return;
  }
  store.set(SIZES_COOKIE, formatSizesCookie(sizes), {
    httpOnly: false,
    sameSite: 'lax',
    path: '/',
    maxAge: THIRTY_DAYS,
    secure: await cookiesAreSecure(),
  });
}

const order = z.object({ orderNumber: z.string().min(1).max(40) });

/** Puts the lines of one of MY orders into this browser's cart (current price and stock apply). */
export async function reorderAction(
  input: unknown,
): Promise<CustomerActionResult<{ added: number; skipped: number }>> {
  const token = await ensureCartToken();
  const result = await customerAction(input, order, async (tx, who, data) => {
    const done = await reorderMyOrder(tx, {
      customerId: who.customer.customerId,
      orderNumber: data.orderNumber,
      cartToken: token,
    });
    if (done === null) throw Object.assign(new Error('not found'), { code: 'ADDRESS_NOT_FOUND' });
    return done;
  });
  if (result.ok) refresh();
  return result;
}

export async function updateProfileAction(input: unknown): Promise<CustomerActionResult> {
  return await customerAction(input, updateProfileSchema, async (tx, who, data) => {
    await updateProfile(
      tx,
      { customerId: who.customer.customerId, userId: who.customer.userId, ip: who.ip },
      data,
    );
  });
}

const sizesSchema = z.object({
  braSizeId: z.uuid().nullable(),
  apparelSizeId: z.uuid().nullable(),
});

export async function saveSizesAction(input: unknown): Promise<CustomerActionResult> {
  const result = await customerAction(input, sizesSchema, async (tx, who, data) => {
    const actor = { customerId: who.customer.customerId, userId: who.customer.userId, ip: who.ip };
    try {
      await setMySizes(tx, actor, data);
    } catch (error) {
      if (error instanceof SizeNotFoundError) {
        throw Object.assign(error, { code: 'CHECKOUT_SIZE' });
      }
      throw error;
    }
    return await mySizeLabels(tx, who.customer.customerId);
  });
  if (!result.ok) return result;
  await writeSizesCookie(result.value);
  return { ok: true, value: undefined };
}

export async function setNewsletterAction(input: unknown): Promise<CustomerActionResult> {
  return await customerAction(
    input,
    z.object({ subscribe: z.boolean() }),
    async (tx, who, data) => {
      await setNewsletter(
        tx,
        { customerId: who.customer.customerId, userId: who.customer.userId, ip: who.ip },
        data,
      );
    },
  );
}

export async function addAddressAction(input: unknown): Promise<CustomerActionResult<string>> {
  return await customerAction(input, addressInputSchema, async (tx, who, data) => {
    return await addAddress(
      tx,
      { customerId: who.customer.customerId, userId: who.customer.userId, ip: who.ip },
      data,
    );
  });
}

export async function deleteAddressAction(input: unknown): Promise<CustomerActionResult> {
  return await customerAction(input, z.object({ id: z.uuid() }), async (tx, who, data) => {
    await deleteAddress(
      tx,
      { customerId: who.customer.customerId, userId: who.customer.userId, ip: who.ip },
      data.id,
    );
  });
}
