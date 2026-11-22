/**
 * Consumer side of the outbox queues. pg-boss delivers at least once, so the
 * external side effect must be idempotent: the outbox dedup key travels as the
 * provider's idempotency key (e.g. the Resend `Idempotency-Key` header). Only
 * then does "the email goes out once" hold when a job is retried after a crash
 * between sending and completing.
 *
 * The guarantee lasts as long as the provider remembers the key (about 24 hours for
 * Resend). A retry after a longer outage can send twice; a consumer-side "sent" record
 * keyed by the dedup key would close that gap (NOTES.md).
 */
export interface OutboundMessage {
  /** The outbox dedup key. A provider that has seen it must not send again. */
  idempotencyKey: string;
  topic: string;
  payload: unknown;
}

export interface MessageSender {
  send(message: OutboundMessage): Promise<void>;
}

export interface QueueJob {
  data: { dedupKey: string; topic: string; payload: unknown };
}

export async function deliverJob(job: QueueJob, sender: MessageSender): Promise<void> {
  await sender.send({
    idempotencyKey: job.data.dedupKey,
    topic: job.data.topic,
    payload: job.data.payload,
  });
}
