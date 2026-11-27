/**
 * Public API of the reports module. Only functions that open their own read-only transaction are
 * exported (`api.ts`, `run.ts`, `dashboard.ts`, `today.ts`), plus the period vocabulary, the CSV
 * rendering and the transaction helper. The raw readers are not exported on purpose
 * (`exports.unit.test.ts` pins this list).
 */
export * from './period.ts';
export * from './api.ts';
export {
  isReportName,
  mayRunReport,
  parseReportRequest,
  reportParamsSchema,
  ReportForbiddenError,
  resultIncludesCost,
  runReport,
  type ParsedReport,
  type ReportParams,
} from './run.ts';
export { runDashboard } from './dashboard.ts';
export { shopToday } from './today.ts';
export { resultToCsv, bpsPlainText } from './csv.ts';
export { inReportTransaction, REPORT_STATEMENT_TIMEOUT_MS, type ReportDb } from './transaction.ts';
export type { MarginRowDto } from './margin.ts';
export { changeOf } from './comparison.ts';
