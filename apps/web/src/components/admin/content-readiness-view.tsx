import type {
  CategoryReadinessDto,
  ContentReadinessDto,
  FindingDto,
  PhotoProblemDto,
  ProductReadinessDto,
} from '@store/shared/dto/content-readiness';

import type { Translate } from '@/lib/admin/message-lookup';

/**
 * The content readiness report as markup. Pure: the report and a translator in, HTML out, so a
 * test renders it with hostile names and reads the result. Every staff-entered value (SKU, slug,
 * names) goes through React's text escaping and is never written as markup, an attribute value or a
 * URL (the editor link is built from the product UUID only).
 */
export type { Translate };
const header = 'px-3 py-2 text-left font-medium';
const cell = 'px-3 py-2 align-top';

function findingText(t: Translate, entry: FindingDto): string {
  const parts = [
    entry.field === null ? null : t(`fields.${entry.field}`),
    entry.locale === null ? null : `(${t(`locale.${entry.locale}`)})`,
  ].filter((part): part is string => part !== null);
  const text = t(`findings.${entry.code}`);
  const where = parts.length === 0 ? text : `${parts.join(' ')}: ${text}`;
  return entry.count === null ? where : `${where} (${String(entry.count)})`;
}

function Findings({ findings, t }: { findings: readonly FindingDto[]; t: Translate }) {
  if (findings.length === 0) return <span>{t('noIssues')}</span>;
  return (
    <ul className="space-y-1">
      {findings.map((entry, index) => (
        <li key={`${entry.code}-${entry.field ?? ''}-${entry.locale ?? ''}-${String(index)}`}>
          <span className={entry.severity === 'blocker' ? 'font-semibold' : 'text-text-muted'}>
            {t(`severity.${entry.severity}`)}
          </span>
          {': '}
          {findingText(t, entry)}
        </li>
      ))}
    </ul>
  );
}

const stateKey = (row: ProductReadinessDto): string =>
  !row.isActive ? 'stateDraft' : row.live ? 'stateLive' : 'stateNotLive';

function ProductsTable({ rows, t }: { rows: readonly ProductReadinessDto[]; t: Translate }) {
  if (rows.length === 0) return <p>{t('empty')}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <caption className="sr-only">{t('productsTitle')}</caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={header}>
              {t('sku')}
            </th>
            <th scope="col" className={header}>
              {t('name')}
            </th>
            <th scope="col" className={header}>
              {t('state')}
            </th>
            <th scope="col" className={header}>
              {t('issues')}
            </th>
            <th scope="col" className={header}>
              {t('edit')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-border">
              <th scope="row" className={`${cell} text-left font-normal`}>
                {row.sku}
              </th>
              <td className={cell}>
                <span lang="uk">{row.nameUk}</span>
                <br />
                <span lang="en" className="text-text-muted">
                  {row.nameEn}
                </span>
              </td>
              <td className={cell}>
                {t(stateKey(row))}
                {row.ready ? ` / ${t('ready')}` : ''}
              </td>
              <td className={cell}>
                <Findings findings={row.findings} t={t} />
              </td>
              <td className={cell}>
                <a
                  href={`/admin/products/${row.id}`}
                  className="inline-flex min-h-11 min-w-11 items-center underline"
                >
                  {t('edit')}
                  <span className="sr-only">{` ${row.sku}`}</span>
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CategoriesTable({ rows, t }: { rows: readonly CategoryReadinessDto[]; t: Translate }) {
  const active = rows.filter((row) => row.isActive);
  if (active.length === 0) return <p>{t('empty')}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <caption className="sr-only">{t('categoriesTitle')}</caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={header}>
              {t('category')}
            </th>
            <th scope="col" className={header}>
              {t('seoUk')}
            </th>
            <th scope="col" className={header}>
              {t('seoEn')}
            </th>
            <th scope="col" className={header}>
              {t('issues')}
            </th>
            <th scope="col" className={header}>
              {t('edit')}
            </th>
          </tr>
        </thead>
        <tbody>
          {active.map((row) => (
            <tr key={row.id} className="border-b border-border">
              <th scope="row" className={`${cell} text-left font-normal`}>
                <span lang="uk">{row.nameUk}</span>
                <br />
                <span lang="en" className="text-text-muted">
                  {row.nameEn}
                </span>
              </th>
              <td className={cell}>{row.seoTextLengthUk}</td>
              <td className={cell}>{row.seoTextLengthEn}</td>
              <td className={cell}>
                <Findings findings={row.findings} t={t} />
              </td>
              <td className={cell}>
                <a
                  href={`/admin/categories/${row.id}`}
                  className="inline-flex min-h-11 min-w-11 items-center underline"
                >
                  {t('edit')}
                  <span className="sr-only">{` ${row.slug}`}</span>
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PhotosTable({ rows, t }: { rows: readonly PhotoProblemDto[]; t: Translate }) {
  if (rows.length === 0) return <p>{t('empty')}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <caption className="sr-only">{t('photosTitle')}</caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={header}>
              {t('sku')}
            </th>
            <th scope="col" className={header}>
              {t('size')}
            </th>
            <th scope="col" className={header}>
              {t('issues')}
            </th>
            <th scope="col" className={header}>
              {t('edit')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.imageId} className="border-b border-border">
              <th scope="row" className={`${cell} text-left font-normal`}>
                {row.productSku}
              </th>
              <td className={cell}>
                {row.width === null || row.height === null
                  ? t('unknownSize')
                  : `${String(row.width)} x ${String(row.height)}`}
              </td>
              <td className={cell}>
                <ul className="space-y-1">
                  {row.issues.map((issue) => (
                    <li key={issue}>{t(`photoIssue.${issue}`)}</li>
                  ))}
                </ul>
              </td>
              <td className={cell}>
                <a
                  href={`/admin/products/${row.productId}`}
                  className="inline-flex min-h-11 min-w-11 items-center underline"
                >
                  {t('edit')}
                  <span className="sr-only">{` ${row.productSku}`}</span>
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SHOW_MODES = ['todo', 'all', 'drafts'] as const;
const link = (show: string, page: number): string =>
  `/admin/content-readiness?show=${show}&page=${String(page)}`;

export function ContentReadinessView({ report, t }: { report: ContentReadinessDto; t: Translate }) {
  const rows = report.products;
  const mode = report.show;
  return (
    <div className="space-y-10">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="max-w-3xl text-text-muted">{t('intro')}</p>
        <p role="status" aria-live="polite" className="text-lg font-semibold">
          {t('readyOfTarget', { ready: report.totals.liveReady, target: report.expectedActive })}
        </p>
        <p className="text-sm text-text-muted">
          {t('generated', { at: report.generatedAt })}{' '}
          <a
            href="/admin/content-readiness?refresh=1"
            className="inline-flex min-h-11 min-w-11 items-center underline"
          >
            {t('refresh')}
          </a>
        </p>
        <p>
          {t('liveLine', {
            live: report.totals.live,
            active: report.totals.active,
            drafts: report.totals.drafts,
          })}
        </p>
      </header>

      <section aria-labelledby="gate" className="space-y-2">
        <h2 id="gate" className="text-lg font-semibold">
          {t('gateTitle')}
        </h2>
        <p role="note" className="font-semibold">
          {report.gatePassed ? t('gatePass') : t('gateFail')}
        </p>
        <ul className="space-y-1">
          {report.acceptance.map((check) => (
            <li key={check.id}>
              <span className="font-semibold">{check.ok ? t('ok') : t('notMet')}</span>
              {': '}
              {t(`check.${check.id}`, { actual: check.actual, expected: check.expected })}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="products" className="space-y-3">
        <h2 id="products" className="text-lg font-semibold">
          {t('productsTitle')}
        </h2>
        <nav aria-label={t('filter')}>
          <ul className="flex flex-wrap gap-3">
            {SHOW_MODES.map((entry) => (
              <li key={entry}>
                <a
                  href={link(entry, 1)}
                  aria-current={entry === mode ? 'true' : undefined}
                  className={`inline-flex min-h-11 min-w-11 items-center underline ${entry === mode ? 'font-semibold' : ''}`}
                >
                  {t(`show.${entry}`)}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <p role="status" aria-live="polite">
          {t('matching', { count: report.matchingProducts })}
        </p>
        <ProductsTable rows={rows} t={t} />
        {report.pages > 1 ? (
          <nav aria-label={t('pages')}>
            <ul className="flex flex-wrap items-center gap-3">
              {report.page > 1 ? (
                <li>
                  <a
                    href={link(mode, report.page - 1)}
                    className="inline-flex min-h-11 min-w-11 items-center underline"
                  >
                    {t('previous')}
                  </a>
                </li>
              ) : null}
              <li>{t('pageOf', { page: report.page, pages: report.pages })}</li>
              {report.page < report.pages ? (
                <li>
                  <a
                    href={link(mode, report.page + 1)}
                    className="inline-flex min-h-11 min-w-11 items-center underline"
                  >
                    {t('next')}
                  </a>
                </li>
              ) : null}
            </ul>
          </nav>
        ) : null}
      </section>

      <section aria-labelledby="categories" className="space-y-3">
        <h2 id="categories" className="text-lg font-semibold">
          {t('categoriesTitle')}
        </h2>
        <p>
          {t('categoriesLine', {
            ready: report.totals.categoriesReady,
            total: report.totals.categories,
          })}
        </p>
        <CategoriesTable rows={report.categories} t={t} />
      </section>

      <section aria-labelledby="photos" className="space-y-3">
        <h2 id="photos" className="text-lg font-semibold">
          {t('photosTitle', {
            count: report.totals.photosWithProblems,
            total: report.totals.photos,
          })}
        </h2>
        <PhotosTable rows={report.photoProblems} t={t} />
        {report.photoProblemsTruncated ? (
          <p role="note">{t('photosTruncated', { limit: report.photoProblems.length })}</p>
        ) : null}
      </section>
    </div>
  );
}
