/**
 * One short, safe description of a failure for a log line: the error name and
 * the driver code (ECONNREFUSED, 57P01, 28P01), never the message, the query
 * text or its parameters. Drizzle wraps the driver error, so the code is on
 * the cause.
 */
export function errorReason(error: unknown): string {
  const source = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  const code = source instanceof Error && 'code' in source ? String(source.code) : undefined;
  return `${source instanceof Error ? source.name : 'Error'}${code === undefined ? '' : ` ${code}`}`;
}
