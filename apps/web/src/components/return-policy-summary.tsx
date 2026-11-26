import { getTranslations } from 'next-intl/server';

import {
  acceptedReturnReasons,
  RETURN_POLICY,
  REASONS_VOLUNTARY,
} from '@store/shared/return-policy';

/**
 * The returns page's summary, built from the SHARED policy (`@store/shared/return-policy`), the same constants as
 * the return form, the server's check and the product JSON-LD, with the same sentence the account shows. It is not
 * editable text: the legal body below it is the lawyer's, this block cannot contradict the form or the markup.
 * The reason labels are the ones the form uses.
 */
export async function ReturnPolicySummary({ windowDays }: { windowDays: number }) {
  const t = await getTranslations('legal');
  const ta = await getTranslations('account');
  const accepted = acceptedReturnReasons();
  return (
    <section aria-labelledby="return-summary" className="rounded-md border border-border p-4">
      <h2 id="return-summary" className="font-display text-xl">
        {t('returnSummaryHeading')}
      </h2>
      <p className="mt-2">
        {ta(RETURN_POLICY.voluntaryReturns ? 'returnsPolicyVoluntary' : 'returnsPolicyStrict', {
          days: windowDays,
        })}
      </p>
      <p className="mt-3 font-medium">{t('returnSummaryAccepted')}</p>
      <ul className="list-disc pl-6" data-testid="accepted-reasons">
        {accepted.map((reason) => (
          <li key={reason} data-reason={reason}>
            {ta(`reason.${reason}`)}
          </li>
        ))}
      </ul>
      {RETURN_POLICY.voluntaryReturns ? null : (
        <>
          <p className="mt-3 font-medium">{t('returnSummaryNotAccepted')}</p>
          <ul className="list-disc pl-6" data-testid="refused-reasons">
            {REASONS_VOLUNTARY.map((reason) => (
              <li key={reason} data-reason={reason}>
                {ta(`reason.${reason}`)}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
