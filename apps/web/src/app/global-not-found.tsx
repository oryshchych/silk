import type { Metadata } from 'next';

import en from '../../messages/en.json';
import uk from '../../messages/uk.json';

import './globals.css';

export const metadata: Metadata = { title: uk.errors.notFoundTitle };

/**
 * Server-rendered 404 for any URL no page handles. The locale layout is a
 * dynamic root layout, so Next cannot compose its own 404 from it (docs:
 * `global-not-found`); this page is a full document and shows both languages.
 */
export default function GlobalNotFound() {
  return (
    <html lang="uk">
      <body className="min-h-dvh bg-surface text-text-primary antialiased">
        <main className="mx-auto flex min-h-dvh max-w-2xl flex-col items-center justify-center gap-3 px-6 text-center">
          <h1 className="font-display text-3xl">{uk.errors.notFoundTitle}</h1>
          <p className="text-text-muted">{uk.errors.notFoundText}</p>
          <p lang="en" className="text-text-muted">
            {en.errors.notFoundTitle}. {en.errors.notFoundText}
          </p>
          <a
            href="/"
            className="rounded-full border border-border px-5 py-2 hover:bg-surface-raised"
          >
            {uk.errors.backHome} / {en.errors.backHome}
          </a>
        </main>
        {/* Every page carries the trademark disclaimer, this standalone document included. */}
        <p
          id="trademark-disclaimer"
          className="mx-auto max-w-2xl px-4 pb-6 text-center text-xs text-text-muted"
        >
          {uk.footer.trademark}
          <span lang="en" className="block">
            {en.footer.trademark}
          </span>
        </p>
      </body>
    </html>
  );
}
