/**
 * The address book. Scoped by the customer id of the session: an address id from another customer
 * answers like a missing one. Ten addresses at most (a limit the row count makes true under a
 * per-customer lock); exactly one default (a partial unique index backs it). Nova Poshta points are
 * checked against OUR directory by the same function checkout uses.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { addresses } from '@store/db/schema';
import type { Reader, Tx } from '@store/db/types';
import { addressDto, type AddressDto } from '@store/shared/dto/account';
import { serialize } from '@store/shared/dto/serialize';
import { normalizeUaPhone } from '@store/shared/phone';

import { DomainError } from '../errors.ts';
import { resolveDelivery } from '../orders/delivery.ts';
import { writeAudit } from '../audit/write-audit.ts';

export const MAX_ADDRESSES = 10;

export class AddressNotFoundError extends DomainError {
  constructor() {
    super('ADDRESS_NOT_FOUND', 'Address not found');
  }
}
export class AddressLimitError extends DomainError {
  constructor() {
    super('ADDRESS_LIMIT', 'Too many saved addresses');
  }
}

const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[\u0000-\u001f]/.test(value), 'no control characters');

const recipient = {
  recipientName: text(240),
  phone: z
    .string()
    .trim()
    .max(40)
    .transform((value) => normalizeUaPhone(value))
    .refine((value): value is string => value !== null, 'phone is not a Ukrainian number'),
  isDefault: z.boolean().default(false),
};

export const addressInputSchema = z.discriminatedUnion('deliveryMethod', [
  z.object({
    deliveryMethod: z.literal('np_warehouse'),
    settlementRef: text(64),
    warehouseRef: text(64),
    ...recipient,
  }),
  z.object({
    deliveryMethod: z.literal('np_courier'),
    settlementRef: text(64),
    street: text(240),
    house: text(40),
    apartment: text(40).optional(),
    ...recipient,
  }),
  z.object({
    deliveryMethod: z.literal('ukrposhta'),
    street: text(240),
    house: text(40),
    apartment: text(40).optional(),
    postcode: z
      .string()
      .trim()
      .regex(/^\d{5}$/),
    ...recipient,
  }),
]);
export type AddressInput = z.output<typeof addressInputSchema>;

interface Who {
  customerId: string;
  userId: string;
  ip: string | null;
}

export async function listMyAddresses(reader: Reader, customerId: string): Promise<AddressDto[]> {
  const rows = await reader
    .select()
    .from(addresses)
    .where(eq(addresses.customerId, customerId))
    .orderBy(desc(addresses.isDefault), asc(addresses.createdAt), asc(addresses.id));
  return rows.map((row) => serialize(addressDto, row));
}

async function lock(tx: Tx, customerId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`addresses:${customerId}`}, 0))`,
  );
}

async function valuesOf(tx: Tx, input: AddressInput) {
  const base = {
    recipientName: input.recipientName,
    phone: input.phone,
    deliveryMethod: input.deliveryMethod,
  };
  const empty = {
    settlementRef: null,
    settlementName: null,
    warehouseRef: null,
    warehouseName: null,
    street: null,
    house: null,
    apartment: null,
    postcode: null,
  };
  if (input.deliveryMethod === 'np_warehouse') {
    const point = await resolveDelivery(tx, {
      method: 'np_warehouse',
      settlementRef: input.settlementRef,
      warehouseRef: input.warehouseRef,
    });
    return {
      ...base,
      ...empty,
      settlementRef: point.settlementRef,
      settlementName: point.settlementName,
      warehouseRef: point.warehouseRef,
      warehouseName: point.warehouseName,
    };
  }
  if (input.deliveryMethod === 'np_courier') {
    const point = await resolveDelivery(tx, {
      method: 'np_courier',
      settlementRef: input.settlementRef,
      address: `${input.street} ${input.house}`,
    });
    return {
      ...base,
      ...empty,
      settlementRef: point.settlementRef,
      settlementName: point.settlementName,
      street: input.street,
      house: input.house,
      apartment: input.apartment ?? null,
    };
  }
  return {
    ...base,
    ...empty,
    street: input.street,
    house: input.house,
    apartment: input.apartment ?? null,
    postcode: input.postcode,
  };
}

export async function addAddress(tx: Tx, who: Who, input: AddressInput): Promise<string> {
  await lock(tx, who.customerId);
  const [count] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(addresses)
    .where(eq(addresses.customerId, who.customerId));
  if ((count?.n ?? 0) >= MAX_ADDRESSES) throw new AddressLimitError();
  const values = await valuesOf(tx, input);
  const first = (count?.n ?? 0) === 0;
  const makeDefault = input.isDefault || first;
  if (makeDefault) {
    await tx
      .update(addresses)
      .set({ isDefault: false })
      .where(eq(addresses.customerId, who.customerId));
  }
  const [row] = await tx
    .insert(addresses)
    .values({ ...values, customerId: who.customerId, isDefault: makeDefault })
    .returning({ id: addresses.id });
  if (row === undefined) throw new Error('address insert returned no row');
  await writeAudit(tx, {
    userId: who.userId,
    action: 'customer.address_added',
    entity: 'address',
    entityId: row.id,
    ip: who.ip,
  });
  return row.id;
}

export async function updateAddress(
  tx: Tx,
  who: Who,
  addressId: string,
  input: AddressInput,
): Promise<void> {
  await lock(tx, who.customerId);
  const [existing] = await tx
    .select({ id: addresses.id })
    .from(addresses)
    .where(and(eq(addresses.id, addressId), eq(addresses.customerId, who.customerId)));
  if (existing === undefined) throw new AddressNotFoundError();
  const values = await valuesOf(tx, input);
  if (input.isDefault) {
    await tx
      .update(addresses)
      .set({ isDefault: false })
      .where(eq(addresses.customerId, who.customerId));
  }
  await tx
    .update(addresses)
    .set(input.isDefault ? { ...values, isDefault: true } : values)
    .where(and(eq(addresses.id, addressId), eq(addresses.customerId, who.customerId)));
  await writeAudit(tx, {
    userId: who.userId,
    action: 'customer.address_updated',
    entity: 'address',
    entityId: addressId,
    ip: who.ip,
  });
}

export async function deleteAddress(tx: Tx, who: Who, addressId: string): Promise<void> {
  await lock(tx, who.customerId);
  const removed = await tx
    .delete(addresses)
    .where(and(eq(addresses.id, addressId), eq(addresses.customerId, who.customerId)))
    .returning({ id: addresses.id, wasDefault: addresses.isDefault });
  const row = removed[0];
  if (row === undefined) throw new AddressNotFoundError();
  if (row.wasDefault) {
    // The oldest remaining address becomes the default, so "one default" stays true.
    await tx.execute(
      sql`UPDATE addresses SET is_default = true
           WHERE id = (SELECT id FROM addresses WHERE customer_id = ${who.customerId}
                        ORDER BY created_at, id LIMIT 1)`,
    );
  }
  await writeAudit(tx, {
    userId: who.userId,
    action: 'customer.address_deleted',
    entity: 'address',
    entityId: addressId,
    ip: who.ip,
  });
}
