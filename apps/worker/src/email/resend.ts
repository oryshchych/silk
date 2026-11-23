/**
 * Resend over plain `fetch` (no SDK: one POST). The outbox dedup key travels as
 * the `Idempotency-Key` header, so a job retried after a crash between sending
 * and completing does not mail twice (while Resend remembers the key, ~24 h).
 *
 * Outside production EVERY recipient is replaced by the catch-all address
 * (`EMAIL_TO_OVERRIDE`, ENVIRONMENTS.md): staging never mails real customers.
 * Error messages carry the status only, never the response body or the
 * recipient (personal data).
 */
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Provider idempotency key: the outbox dedup key plus a per-recipient suffix. */
  idempotencyKey: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export class EmailSendError extends Error {
  readonly status: number | null;

  constructor(status: number | null) {
    super(
      status === null ? 'email provider unreachable' : `email provider answered ${String(status)}`,
    );
    this.name = 'EmailSendError';
    this.status = status;
  }
}

const ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_TIMEOUT_MS = 15_000;

export function createResendSender(options: {
  apiKey: string;
  from: string;
  /** Set outside production: replaces every recipient. */
  toOverride: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): EmailSender {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    async send(message) {
      const overridden = options.toOverride !== null;
      const response = await doFetch(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': message.idempotencyKey,
        },
        body: JSON.stringify({
          from: options.from,
          to: [options.toOverride ?? message.to],
          subject: overridden ? `[staging] ${message.subject}` : message.subject,
          html: message.html,
          text: message.text,
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      }).catch(() => {
        throw new EmailSendError(null);
      });
      // 2xx is sent; 4xx other than 429 will never succeed, but a retry is harmless and the
      // dead-letter queue keeps it visible, so every non-2xx is a failure of the job.
      if (!response.ok) throw new EmailSendError(response.status);
    },
  };
}
