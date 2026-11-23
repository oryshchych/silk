/** Pages to show: first, last and a window around the current one. */
export function pageWindow(current: number, total: number): (number | 'gap')[] {
  const wanted = new Set([1, total, current - 1, current, current + 1]);
  const pages = [...wanted].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const result: (number | 'gap')[] = [];
  for (const page of pages) {
    const last = result.at(-1);
    if (typeof last === 'number' && page - last > 1) result.push('gap');
    result.push(page);
  }
  return result;
}
