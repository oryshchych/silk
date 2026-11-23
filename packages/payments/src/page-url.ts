/**
 * A payment page URL comes from the provider's ANSWER and is stored, replayed and redirected to.
 * Only an https URL on the provider's own domain (or a configured sandbox host) is accepted:
 * anything else (`javascript:`, another host, credentials in the URL) is not a payment page.
 */
export function isPaymentPageUrl(raw: string, domains: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return false;
  const host = url.hostname.toLowerCase();
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}
