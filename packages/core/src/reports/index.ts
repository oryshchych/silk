/**
 * Public API of the reports module. Only functions that open their own read-only transaction are
 * exported (`api.ts`), plus the period vocabulary and the transaction helper. The raw readers are not
 * exported on purpose (`exports.unit.test.ts` pins this list).
 */
export * from './period.ts';
export * from './api.ts';
export { inReportTransaction, REPORT_STATEMENT_TIMEOUT_MS, type ReportDb } from './transaction.ts';
export type { MarginRowDto } from './margin.ts';
export { changeOf } from './comparison.ts';
