import { describe, expect, it } from 'vitest';

import { deliverJob, type MessageSender } from '../src/deliver.ts';

const job = { data: { dedupKey: 'order-created:1', topic: 'email.order-created', payload: {} } };

describe('deliverJob', () => {
  it('passes the outbox dedup key as the provider idempotency key', async () => {
    const seen: string[] = [];
    const sender: MessageSender = {
      send: (message) => {
        seen.push(message.idempotencyKey);
        return Promise.resolve();
      },
    };
    await deliverJob(job, sender);
    expect(seen).toEqual(['order-created:1']);
  });

  it('a hung provider call times out, so the job fails and is retried instead of stalling', async () => {
    const hung: MessageSender = { send: () => new Promise(() => undefined) };
    await expect(deliverJob(job, hung, 50)).rejects.toThrow('timed out');
  });

  it('a provider error propagates (the queue retries it)', async () => {
    const failing: MessageSender = { send: () => Promise.reject(new Error('provider 503')) };
    await expect(deliverJob(job, failing)).rejects.toThrow('provider 503');
  });
});
