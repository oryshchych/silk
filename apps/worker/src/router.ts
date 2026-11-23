/**
 * Routes outbox messages (queue jobs) to their consumers by topic. A topic with no consumer
 * is a failure, not a silent drop: the job retries and lands in the dead-letter queue, where
 * someone sees it. Money alerts are logged (one JSON line, ids only) AND fail the same way until
 * the alert channel exists (Q15).
 */
import type { Reader } from '@store/db/types';

import type { MessageSender, OutboundMessage } from './deliver.ts';
import { handleOrderCreated } from './email/order-created.ts';
import type { EmailSender } from './email/resend.ts';

/** An `alert.*` message has no channel yet: it is logged AND fails, so it lands in the dead-letter queue. */
export class AlertUndeliveredError extends Error {
  constructor(topic: string) {
    super(`alert ${topic} has no delivery channel yet`);
    this.name = 'AlertUndeliveredError';
  }
}

export class UnhandledTopicError extends Error {
  constructor(topic: string) {
    super(`no consumer for topic ${topic}`);
    this.name = 'UnhandledTopicError';
  }
}

const orderIdOf = (payload: unknown): string | null => {
  if (typeof payload !== 'object' || payload === null || !('orderId' in payload)) return null;
  return typeof payload.orderId === 'string' ? payload.orderId : null;
};

export function createMessageSender(deps: {
  reader: Reader;
  email: EmailSender;
  siteUrl: string;
  log?: (line: string) => void;
}): MessageSender {
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  return {
    async send(message: OutboundMessage): Promise<void> {
      if (message.topic === 'email.order-created') {
        await handleOrderCreated(
          { reader: deps.reader, sender: deps.email, siteUrl: deps.siteUrl },
          { dedupKey: message.idempotencyKey, payload: message.payload },
        );
        return;
      }
      if (message.topic.startsWith('alert.')) {
        log(
          JSON.stringify({
            level: 'error',
            scope: 'alert',
            topic: message.topic,
            orderId: orderIdOf(message.payload),
          }),
        );
        // Until the alert channel exists (Q15) a money alert must not look delivered: failing the
        // job keeps it in the dead-letter queue, where it stays visible and can be redriven.
        throw new AlertUndeliveredError(message.topic);
      }
      throw new UnhandledTopicError(message.topic);
    },
  };
}
