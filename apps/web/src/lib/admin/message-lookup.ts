/**
 * A translator over a message subtree for keys composed at run time (`findings.<code>`): the typed
 * `next-intl` keys cannot express them. Plain `{name}` placeholders only (no plurals). A missing
 * key renders its own path, so a gap is visible in the page and caught by the smoke check.
 */
export type Translate = (key: string, values?: Record<string, string | number>) => string;

function walk(messages: unknown, path: readonly string[]): unknown {
  let node: unknown = messages;
  for (const part of path) {
    if (typeof node !== 'object' || node === null || !Object.hasOwn(node, part)) return undefined;
    node = Object.getOwnPropertyDescriptor(node, part)?.value;
  }
  return node;
}

export function makeTranslator(messages: unknown, namespace: string): Translate {
  return (key, values) => {
    const leaf = walk(messages, [...namespace.split('.'), ...key.split('.')]);
    if (typeof leaf !== 'string') return `${namespace}.${key}`;
    return leaf.replace(/\{(\w+)\}/g, (whole, name: string) => {
      const value = values?.[name];
      return value === undefined ? whole : String(value);
    });
  };
}
