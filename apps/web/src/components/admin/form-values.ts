/** The text fields of a submitted form as a plain object (an absent or non-text field is ''). */
export function formValues(
  form: HTMLFormElement,
  names: readonly string[],
): Record<string, string> {
  const data = new FormData(form);
  return Object.fromEntries(
    names.map((name) => {
      const value = data.get(name);
      return [name, typeof value === 'string' ? value : ''];
    }),
  );
}
