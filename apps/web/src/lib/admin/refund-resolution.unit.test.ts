import { describe, expect, it } from 'vitest';

import {
  OUTCOME_FIELD,
  REFUND_OUTCOMES,
  parseOutcome,
  resolvePayload,
} from './refund-resolution.ts';

/** What the browser puts in the form data for a submit: the clicked button's own name and value. */
const clicked = (button: 'sent' | 'notSent'): FormData => {
  const data = new FormData();
  data.append('note', 'portal, 26 Nov');
  data.append(OUTCOME_FIELD, REFUND_OUTCOMES[button]);
  return data;
};

describe('the refund resolution buttons', () => {
  it('"the money was returned" is succeeded and "was NOT returned" is failed, each from its own click', () => {
    const sent = resolvePayload('op-1', clicked('sent').get(OUTCOME_FIELD), 'portal');
    const notSent = resolvePayload('op-1', clicked('notSent').get(OUTCOME_FIELD), 'portal');
    expect(sent).toEqual({ operationId: 'op-1', outcome: 'succeeded', note: 'portal' });
    expect(notSent).toEqual({ operationId: 'op-1', outcome: 'failed', note: 'portal' });
  });

  it('the two values are different (a swapped or defaulted button cannot go unnoticed)', () => {
    expect(REFUND_OUTCOMES.sent).not.toBe(REFUND_OUTCOMES.notSent);
  });

  it('anything else, or no click at all, makes no action (never a default to "returned")', () => {
    for (const value of [
      null,
      undefined,
      '',
      'Succeeded',
      'maybe',
      'failed ',
      1,
      {},
      new File([], 'x'),
    ]) {
      expect(parseOutcome(value)).toBeNull();
      expect(resolvePayload('op-1', value, 'portal')).toBeNull();
    }
    expect(resolvePayload('op-1', new FormData().get(OUTCOME_FIELD), 'portal')).toBeNull();
  });
});
