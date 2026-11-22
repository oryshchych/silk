import { describe, expect, it } from 'vitest';

import { ALLOWED_TRANSITIONS, canTransition, type OrderStatus } from './transitions.ts';

const ALL = Object.keys(ALLOWED_TRANSITIONS) as OrderStatus[];

describe('order status transitions', () => {
  it('allows the documented forward path and the skeleton jump to shipped', () => {
    expect(canTransition('pending', 'confirmed')).toBe(true);
    expect(canTransition('confirmed', 'processing')).toBe(true);
    expect(canTransition('processing', 'shipped')).toBe(true);
    expect(canTransition('shipped', 'delivered')).toBe(true);
    expect(canTransition('delivered', 'returned')).toBe(true);
    expect(canTransition('pending', 'shipped')).toBe(true); // skeleton deviation
  });

  it('cancels only before shipping', () => {
    for (const from of ['pending', 'confirmed', 'processing'] as const) {
      expect(canTransition(from, 'cancelled')).toBe(true);
    }
    for (const from of ['shipped', 'delivered', 'cancelled', 'returned'] as const) {
      expect(canTransition(from, 'cancelled')).toBe(false);
    }
  });

  it('terminal statuses go nowhere and nothing goes back', () => {
    for (const to of ALL) {
      expect(canTransition('cancelled', to)).toBe(false);
      expect(canTransition('returned', to)).toBe(false);
    }
    expect(canTransition('shipped', 'processing')).toBe(false);
    expect(canTransition('delivered', 'shipped')).toBe(false);
  });
});
