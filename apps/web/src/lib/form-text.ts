/** A text field of a submitted form; a file or a missing field reads as empty. */
export function fieldText(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
}
