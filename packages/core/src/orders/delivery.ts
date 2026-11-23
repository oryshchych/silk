/**
 * Delivery and payment-method checks of checkout. Pure validation plus
 * directory lookups; nothing here writes.
 */
import { sql } from 'drizzle-orm';

import type { Tx } from '@store/db/types';
import type { Money } from '@store/shared/money';

import { isCanonicalUaPhone } from '@store/shared/phone';

import {
  CodNotAllowedError,
  ContactInvalidError,
  DeliveryInvalidError,
  PaymentMethodUnavailableError,
} from '../errors.ts';
import { resolveNpPoint } from '../shipping/np-directory.ts';
import type { ShippingSettings } from '../shipping/rules.ts';
import type { CreateOrderInput } from './types.ts';

/** The per-phone COD limit compares exact strings, so only the canonical form gets in. */
export function assertContact(contact: CreateOrderInput['contact']): void {
  if (!isCanonicalUaPhone(contact.phone)) throw new ContactInvalidError('phone');
}

const MIN_ADDRESS = 5;
const MAX_ADDRESS = 300;

export interface ResolvedDelivery {
  method: CreateOrderInput['delivery']['method'];
  settlementRef: string | null;
  settlementName: string | null;
  warehouseRef: string | null;
  warehouseName: string | null;
  address: string | null;
}

function cleanAddress(raw: string | undefined): string {
  const address = raw?.trim().replace(/\s+/g, ' ') ?? '';
  if (address.length < MIN_ADDRESS || address.length > MAX_ADDRESS) {
    throw new DeliveryInvalidError('address is missing or has an unusable length');
  }
  return address;
}

/** Validates the delivery fields against the method and the Nova Poshta directory. */
export async function resolveDelivery(
  tx: Tx,
  delivery: CreateOrderInput['delivery'],
): Promise<ResolvedDelivery> {
  const empty = {
    settlementRef: null,
    settlementName: null,
    warehouseRef: null,
    warehouseName: null,
    address: null,
  };
  switch (delivery.method) {
    case 'pickup':
      return { method: 'pickup', ...empty };
    case 'ukrposhta':
      return { method: 'ukrposhta', ...empty, address: cleanAddress(delivery.address) };
    case 'np_courier': {
      const point = await resolveNpPoint(tx, { settlementRef: delivery.settlementRef }, false);
      return {
        method: 'np_courier',
        settlementRef: point.settlementRef,
        settlementName: point.settlementName,
        warehouseRef: null,
        warehouseName: null,
        address: cleanAddress(delivery.address),
      };
    }
    case 'np_warehouse': {
      const point = await resolveNpPoint(tx, delivery, true);
      return {
        method: 'np_warehouse',
        settlementRef: point.settlementRef,
        settlementName: point.settlementName,
        warehouseRef: point.warehouseRef,
        warehouseName: point.warehouseName,
        address: null,
      };
    }
  }
}

/**
 * The method must be switched on, and COD has two guards (ADR-3): an amount
 * cap and a limit on unconfirmed COD orders per phone. The count is made
 * under a transaction-scoped advisory lock on the phone, so two parallel
 * checkouts cannot both take the last slot. The lock is taken after the
 * cart, intent and promo/variant locks and nothing waits for another lock
 * while holding it, so it cannot take part in a cycle.
 */
export async function assertPaymentAllowed(
  tx: Tx,
  input: Pick<CreateOrderInput, 'paymentProvider' | 'contact'>,
  total: Money,
  config: ShippingSettings,
): Promise<void> {
  if (!config.paymentProviders[input.paymentProvider]) throw new PaymentMethodUnavailableError();
  if (input.paymentProvider !== 'cod') return;
  if (config.codMaxAmount !== null && total > config.codMaxAmount) {
    throw new CodNotAllowedError('amount');
  }
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`cod-phone:${input.contact.phone}`}, 0))`,
  );
  const held = await tx.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM orders
         WHERE payment_provider = 'cod' AND customer_phone = ${input.contact.phone}
           AND status = 'pending'`,
  );
  if ((held.rows[0]?.n ?? 0) >= config.codMaxPendingPerPhone) {
    throw new CodNotAllowedError('pending_limit');
  }
}
