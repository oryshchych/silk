/**
 * Next викликає `register` і в Node, і в Edge runtime. Node-специфічний код
 * (process.exit) — окремим модулем, щоб Edge-збірка його не тягнула.
 */
export async function register(): Promise<void> {
  // eslint-disable-next-line no-restricted-properties -- NEXT_RUNTIME — константа збірки, яку Next підставляє статично; це не конфігурація середовища
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node');
  }
}
