/**
 * Routes outbox messages (queue jobs) to their consumers by topic. A topic with no consumer
 * is a failure, not a silent drop: the job retries and lands in the dead-letter queue, where
 * someone sees it. Money alerts are logged (one JSON line, ids only) AND fail the same way until
 * the alert channel exists (Q15).
 */
import { z } from 'zod';

import type { FiscalDeps } from '@store/core/fiscal';
import { issueFiscalReceipt } from '@store/core/fiscal';
import type { Reader } from '@store/db/types';

import type { MessageSender, OutboundMessage } from './deliver.ts';
import { handleAccountLink } from './email/account-emails.ts';
import { handleBackInStock } from './email/back-in-stock.ts';
import { handleCartReminder } from './email/cart-reminder.ts';
import { handleOrderCreated } from './email/order-created.ts';
import {
  handlePaymentFailed,
  handlePaymentReceived,
  handleRefundIssued,
} from './email/payment-emails.ts';
import type { EmailSender } from './email/resend.ts';
import { handleWaybillCreated } from './email/waybill-email.ts';

/** An `alert.*` message has no channel yet: it is logged AND fails, so it lands in the dead-letter queue. */
export class AlertUndeliveredError extends Error {
  constructor(topic: string) {
    super(`alert ${topic} has no delivery channel yet`);
    this.name = 'AlertUndeliveredError';
  }
}

/** The fiscal provider has no credentials yet (OWNER_QUEUE Q3): the job fails and retries, the document stays pending. */
export class FiscalNotConfiguredError extends Error {
  constructor() {
    super('no fiscal provider is configured');
    this.name = 'FiscalNotConfiguredError';
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
  // Only a well-formed id is logged: the payload is data, and a log line is not a place for it.
  const parsed = z.uuid().safeParse(payload.orderId);
  return parsed.success ? parsed.data : null;
};

export function createMessageSender(deps: {
  reader: Reader;
  email: EmailSender;
  siteUrl: string;
  /** `AUTH_SECRET`: the account links are rebuilt from a token id with a key derived from it. */
  authSecret?: string | undefined;
  /** Null until the Checkbox account exists (Q3). */
  fiscal: FiscalDeps | null;
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
      const mail = { reader: deps.reader, sender: deps.email, siteUrl: deps.siteUrl };
      const envelope = { dedupKey: message.idempotencyKey, payload: message.payload };
      if (message.topic === 'email.payment-received') {
        await handlePaymentReceived(mail, envelope);
        return;
      }
      if (message.topic === 'email.payment-failed') {
        await handlePaymentFailed(mail, envelope);
        return;
      }
      if (message.topic === 'email.refund-issued') {
        await handleRefundIssued(mail, envelope);
        return;
      }
      if (message.topic === 'email.waybill-created') {
        await handleWaybillCreated(mail, envelope);
        return;
      }
      if (message.topic === 'email.account-verify' || message.topic === 'email.password-reset') {
        await handleAccountLink({ ...mail, authSecret: deps.authSecret }, envelope);
        return;
      }
      if (message.topic === 'email.back-in-stock') {
        await handleBackInStock({ ...mail, authSecret: deps.authSecret }, envelope);
        return;
      }
      if (message.topic === 'email.cart-reminder') {
        await handleCartReminder({ ...mail, authSecret: deps.authSecret }, envelope);
        return;
      }
      if (message.topic === 'fiscal.issue-receipt') {
        if (deps.fiscal === null) throw new FiscalNotConfiguredError();
        const documentId = z.object({ documentId: z.uuid() }).safeParse(message.payload);
        if (!documentId.success) throw new Error('malformed fiscal payload');
        await issueFiscalReceipt(deps.fiscal, documentId.data.documentId);
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
