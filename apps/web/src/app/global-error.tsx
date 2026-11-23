'use client';

import en from '../../messages/en.json';
import uk from '../../messages/uk.json';

/**
 * Last resort: the locale layout itself failed, so no provider or locale is
 * available. Both languages are shown, from the message files.
 */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="uk">
      <body className="bg-surface text-text-primary">
        <main className="mx-auto flex min-h-dvh max-w-2xl flex-col items-center justify-center gap-3 px-6 text-center">
          <h1 className="font-display text-3xl">{uk.errors.errorTitle}</h1>
          <p lang="en" className="text-text-muted">
            {en.errors.errorTitle}
          </p>
          <button
            type="button"
            onClick={reset}
            className="rounded-full border border-border px-5 py-2"
          >
            {uk.errors.retry} / {en.errors.retry}
          </button>
        </main>
      </body>
    </html>
  );
}
