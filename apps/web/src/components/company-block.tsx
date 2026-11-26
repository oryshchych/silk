import { getTranslations } from 'next-intl/server';

import type { CompanyProfileDto } from '@store/shared/dto/legal';

type Key = keyof CompanyProfileDto;

const COMPANY: readonly Key[] = ['legalName', 'taxId', 'registeredAddress'];
const CONTACT: readonly Key[] = ['phone', 'email', 'telegram', 'viber', 'address'];

/**
 * Company and contact details from `settings.company` and `settings.contacts`. A value the owner has not
 * entered is shown as an explicit "not set" marker (`data-placeholder`), never as a made-up value, and none
 * of this is ever put into structured data (owner queue Q77). Values are plain text, escaped by React.
 */
export async function CompanyBlock({
  profile,
  which,
}: {
  profile: CompanyProfileDto;
  which: 'company' | 'contacts';
}) {
  const t = await getTranslations('legal');
  const keys = which === 'company' ? COMPANY : CONTACT;
  return (
    <section aria-labelledby={`${which}-details`} className="mt-6">
      <h2 id={`${which}-details`} className="font-display text-xl">
        {which === 'company' ? t('companyHeading') : t('contactsHeading')}
      </h2>
      <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        {keys.map((key) => (
          <div key={key} className="contents">
            <dt className="text-text-muted">{t(key)}</dt>
            <dd>
              {profile[key] === null ? (
                <span data-placeholder="true" className="italic text-text-muted">
                  {t('notSet')}
                </span>
              ) : (
                profile[key]
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
