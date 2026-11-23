/** Placeholder for the filter panel while its options load. Decorative: hidden from assistive tech. */
export function FiltersSkeleton() {
  return (
    <div aria-hidden="true" className="flex animate-pulse flex-col gap-3">
      <div className="h-10 rounded-sm bg-surface-raised" />
      <div className="h-24 rounded-sm bg-surface-raised" />
      <div className="h-24 rounded-sm bg-surface-raised" />
      <div className="h-10 rounded-full bg-surface-raised" />
    </div>
  );
}
