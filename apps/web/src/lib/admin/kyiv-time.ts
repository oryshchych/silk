/**
 * An instant as the Kyiv wall-clock text a `datetime-local` input takes (`YYYY-MM-DDTHH:mm`), the
 * counterpart of the server turning that text back into an instant in `Europe/Kyiv`.
 */
const FORMAT = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Kyiv',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function toKyivLocalInput(iso: string | null): string {
  if (iso === null) return '';
  return FORMAT.format(new Date(iso)).replace(' ', 'T');
}
