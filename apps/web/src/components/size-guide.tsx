import { getTranslations } from 'next-intl/server';

import { BAND_STEP, CUP_TABLE } from '@store/core/bra-size';

/** Table of the correspondence the calculator uses (`CUP_TABLE`), for the bands this product comes in. */
export async function SizeGuide({ bands }: { bands: readonly number[] }) {
  const t = await getTranslations('product');
  const half = Math.floor(BAND_STEP / 2);
  return (
    <div className="flex flex-col gap-4 text-sm">
      <section aria-labelledby="size-guide-measure" className="flex flex-col gap-2">
        <h3 id="size-guide-measure" className="font-medium">
          {t('guideMeasureTitle')}
        </h3>
        <ol className="flex list-decimal flex-col gap-1 pl-5">
          <li>{t('guideMeasureUnderbust')}</li>
          <li>{t('guideMeasureBust')}</li>
        </ol>
        <p className="text-text-muted">{t('guideMeasureTip')}</p>
      </section>
      <p className="text-text-muted">{t('guideHint')}</p>
      <table className="w-full max-w-md border-collapse text-left">
        <thead>
          <tr>
            <th scope="col" className="border-b border-border py-1 pr-4 font-medium">
              {t('guideBand')}
            </th>
            <th scope="col" className="border-b border-border py-1 font-medium">
              {t('guideBandSize')}
            </th>
          </tr>
        </thead>
        <tbody>
          {bands.map((band) => (
            <tr key={band}>
              <td className="border-b border-border py-1 pr-4">{`${String(band - half)}–${String(band + half)}`}</td>
              <td className="border-b border-border py-1">{band}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="w-full max-w-md border-collapse text-left">
        <thead>
          <tr>
            <th scope="col" className="border-b border-border py-1 pr-4 font-medium">
              {t('guideCup')}
            </th>
            <th scope="col" className="border-b border-border py-1 font-medium">
              {t('guideCupSize')}
            </th>
          </tr>
        </thead>
        <tbody>
          {CUP_TABLE.map((row, index) => {
            const next = CUP_TABLE[index + 1];
            const to = next === undefined ? row.from + 1 : next.from - 1;
            return (
              <tr key={row.cup}>
                <td className="border-b border-border py-1 pr-4">
                  {row.from === to ? String(row.from) : `${String(row.from)}–${String(to)}`}
                </td>
                <td className="border-b border-border py-1">{row.cup}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
