/** The frame of a login-step page: centred card with a heading. */
export function AuthCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
      <div className="rounded-lg border border-border bg-surface-raised p-6">
        <h1 className="mb-4 text-xl font-semibold">{title}</h1>
        {children}
      </div>
    </main>
  );
}

export const fieldClass =
  'mt-1 block min-h-11 w-full rounded-md border border-border bg-surface px-3 text-text-primary';
export const buttonClass =
  'min-h-11 min-w-11 rounded-md bg-accent px-4 font-medium text-accent-contrast disabled:opacity-60';
