import { useTranslations } from 'next-intl';

export default function AdminLoading() {
  const t = useTranslations('admin.state');
  return (
    <p role="status" aria-live="polite">
      {t('loading')}
    </p>
  );
}
