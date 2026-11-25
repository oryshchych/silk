/**
 * One audit row per admin mutation, written in the SAME transaction as the change (AGENTS.md
 * section 3). The author and the client address come from the verified session, never from the
 * request body. Credentials never enter a diff: any key that looks like one is replaced.
 */
import { auditLog } from '@store/db/schema';
import type { Tx } from '@store/db/types';

export interface AuditEntry {
  userId: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  diff?: Record<string, unknown> | null;
  ip?: string | null;
}

const SECRET_KEY = /pass(word)?|secret|token|hash|code|otp|key|authorization|cookie/i;
const MAX_DEPTH = 4;

/** A copy of `value` with every credential-looking key replaced by "[redacted]". */
export function redactDiff(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.map((item) => redactDiff(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        SECRET_KEY.test(key) ? '[redacted]' : redactDiff(inner, depth + 1),
      ]),
    );
  }
  return value;
}

export async function writeAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values({
    userId: entry.userId,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    diff: entry.diff === undefined || entry.diff === null ? null : redactDiff(entry.diff),
    ip: entry.ip ?? null,
  });
}
