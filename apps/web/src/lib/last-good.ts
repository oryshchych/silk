/**
 * Runs a loader and remembers its last successful result per key. If the
 * loader later fails (a database flap), the remembered result is returned
 * instead of an empty one; with nothing remembered yet the caller's fallback
 * is. The failure is reported, never swallowed silently.
 */
export function createLastGood<T>(): (
  key: string,
  load: () => Promise<T>,
  options: { fallback: T; onError: (error: unknown) => void },
) => Promise<T> {
  const remembered = new Map<string, T>();
  return async (key, load, options) => {
    try {
      const value = await load();
      remembered.set(key, value);
      return value;
    } catch (error) {
      options.onError(error);
      return remembered.get(key) ?? options.fallback;
    }
  };
}
