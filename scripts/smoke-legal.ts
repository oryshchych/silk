/**
 * Smoke checks of the legal pages on the BUILT server (phase 8), against a seeded database: every page in both
 * languages renders its REAL TEXT (title, the "Draft: needs a lawyer" notice, no raw message keys), carries the
 * footer links and the trademark disclaimer, a self canonical and a full hreflang pair, the placeholders show
 * as "not set", the FAQ markup equals the visible questions, the sitemap lists the pages with a real lastmod,
 * and unknown words are 404s that store nothing.
 */
import { createDb } from '../packages/db/src/client.ts';
import en from '../apps/web/messages/en.json' with { type: 'json' };
import uk from '../apps/web/messages/uk.json' with { type: 'json' };
import { LEGAL_KINDS, LEGAL_LOCALES, legalPath } from '../packages/shared/src/legal.ts';
import { legalDraft } from '../packages/shared/src/legal-drafts.ts';

interface Context {
  databaseUrl: string;
  base: string;
  site: string;
  check: (name: string, ok: boolean) => void;
  storedFiles: () => number;
}

const DISCLAIMER = {
  uk: 'Усі торгові марки та назви брендів належать їхнім законним власникам',
  en: 'All trademarks and brand names belong to their respective owners',
} as const;
const NOTICE = { uk: 'Чернетка: потребує юриста', en: 'Draft: needs a lawyer' } as const;
const NOT_SET = { uk: 'Не вказано', en: 'Not set' } as const;
const RAW_KEY = /\b(?:legal|footer|nav)\.[a-zA-Z]+\b|MISSING_MESSAGE/;

const prefix = (locale: 'uk' | 'en'): string => (locale === 'uk' ? '' : '/en');

async function page(url: string): Promise<{ status: number; html: string }> {
  const response = await fetch(url, { redirect: 'manual' });
  return { status: response.status, html: await response.text() };
}

/** Hostile html written AROUND the service (straight into the table): the page must still render it inert. */
const HOSTILE =
  '<p>' +
  NOTICE.en +
  '</p><script>window.__pwned=1</script><img src=x onerror="window.__pwned=2">' +
  '<a href="javascript:window.__pwned=3">click</a><iframe src="https://evil.example"></iframe>' +
  '<p onclick="window.__pwned=4">safe text</p><svg onload="window.__pwned=5"></svg>';

export async function runLegalSmoke({
  base,
  databaseUrl,
  site,
  check,
  storedFiles,
}: Context): Promise<void> {
  // A newer published version of terms/en whose stored html is hostile. Nothing has rendered terms/en yet,
  // so this is what the page cache is filled from (a smoke run starts from a fresh build copy).
  const handle = createDb(databaseUrl, { max: 1 });
  try {
    await handle.pool.query(
      `INSERT INTO legal_documents (kind, locale, version, title, status, body_html, effective_from, published_at)
       VALUES ('terms', 'en', '2', $1, 'published', $2, now() - interval '1 hour', now() - interval '1 hour')`,
      [legalDraft('terms', 'en').title, HOSTILE],
    );
    // A BOMB: 199 990 `<` is inside the table's CHECK and the sanitiser's input limit, and grows to 800 000
    // characters when sanitised, so the render pass refuses it. The page must answer 200 with no body, not 500.
    await handle.pool.query(
      `INSERT INTO legal_documents (kind, locale, version, title, status, body_html, effective_from, published_at)
       VALUES ('privacy', 'en', '2', $1, 'published', $2, now() - interval '1 hour', now() - interval '1 hour')`,
      [legalDraft('privacy', 'en').title, '<'.repeat(199_990)],
    );
  } finally {
    await handle.close();
  }
  const hostile = await page(`${base}/en${legalPath('terms')}`);
  check(
    'a hostile stored body renders inert over a built server (no script, handler, javascript: URL, iframe or svg), its text stays',
    hostile.status === 200 &&
      !/<script[^>]*>window|onerror=|onclick=|onload=|javascript:|<iframe|<svg/i.test(
        hostile.html,
      ) &&
      hostile.html.includes('safe text') &&
      hostile.html.includes('click'),
  );

  const bomb = await page(`${base}/en${legalPath('privacy')}`);
  check(
    'a stored body that grows past the sanitiser limit answers 200 with the title and no body, not 500',
    bomb.status === 200 &&
      new RegExp(`<h1[^>]*>${legalDraft('privacy', 'en').title}</h1>`).test(bomb.html) &&
      !bomb.html.includes('&lt;&lt;&lt;'),
  );

  for (const locale of LEGAL_LOCALES) {
    for (const kind of LEGAL_KINDS) {
      // `about` exists in Ukrainian only (the seed): its English side is checked below as a one-language page.
      if (kind === 'about' && locale === 'en') continue;
      const oneLanguage = kind === 'about';
      const path = `${prefix(locale)}${legalPath(kind)}`;
      const { status, html } = await page(`${base}${path}`);
      const draft = legalDraft(kind, locale);
      const text = html.replace(/<[^>]*>/g, ' ');
      check(
        `legal ${locale}/${kind}: 200, lang, the title in the h1, the draft notice, no raw keys`,
        status === 200 &&
          html.includes(`<html lang="${locale}"`) &&
          new RegExp(`<h1[^>]*>${draft.title}</h1>`).test(html) &&
          // The bomb page has no body by design (the render pass refused it): only the title is asserted there.
          (kind === 'privacy' && locale === 'en' ? true : text.includes(NOTICE[locale])) &&
          !RAW_KEY.test(text),
      );
      check(
        `legal ${locale}/${kind}: self canonical, indexable, both hreflang and x-default, the disclaimer`,
        html.includes(`rel="canonical" href="${site}${path}"`) &&
          !html.includes('name="robots" content="noindex') &&
          (oneLanguage
            ? // A page published in one language: a self canonical and NO alternate, no switch link, no og alternate.
              !html.includes('hrefLang=') &&
              !html.includes(`/en${legalPath(kind)}`) &&
              !html.includes('og:locale:alternate')
            : html.includes(`hrefLang="en" href="${site}/en${legalPath(kind)}"`) &&
              html.includes(`hrefLang="uk" href="${site}${legalPath(kind)}"`) &&
              html.includes('hrefLang="x-default"')) &&
          text.includes(DISCLAIMER[locale]),
      );
    }
    // The footer of any page lists every published page of THIS language.
    const home = await page(`${base}${locale === 'uk' ? '/' : '/en'}`);
    check(
      `footer ${locale}: a link to every legal page and the disclaimer`,
      LEGAL_KINDS.every(
        (kind) =>
          (kind === 'about' && locale === 'en') ===
          !home.html.includes(`href="${prefix(locale)}${legalPath(kind)}"`),
      ) && home.html.includes(DISCLAIMER[locale]),
    );
    const contacts = await page(`${base}${prefix(locale)}${legalPath('contacts')}`);
    check(
      `contacts ${locale}: unset company data shows the "not set" marker, never a value`,
      contacts.html.includes('data-placeholder="true"') &&
        contacts.html.replace(/<[^>]*>/g, ' ').includes(NOT_SET[locale]),
    );
    const faq = await page(`${base}${prefix(locale)}${legalPath('faq')}`);
    const visible = [...faq.html.matchAll(/<h2>/g)].length;
    const ld = /<script type="application\/ld\+json">([^<]*"FAQPage"[^<]*)<\/script>/.exec(
      faq.html,
    );
    const questions =
      ld?.[1] === undefined ? -1 : (ld[1].match(/"@type":"Question"/g) ?? []).length;
    check(
      `faq ${locale}: FAQPage markup has exactly the visible questions (${String(visible)})`,
      visible > 0 && questions === visible,
    );
  }

  // The one-language page: its English URL is the shared 404 (with the disclaimer, in both languages), and the
  // sitemap lists it once with no alternates.
  const aboutEn = await page(`${base}/en${legalPath('about')}`);
  check(
    'a legal page published in Ukrainian only: its English URL is a 404 that carries the disclaimer',
    aboutEn.status === 404 &&
      aboutEn.html.includes(DISCLAIMER.en) &&
      aboutEn.html.includes('name="robots" content="noindex'),
  );
  const pagesXml = await page(`${base}/sitemaps/pages.xml`);
  check(
    'the sitemap lists the one-language page once, with no alternates',
    pagesXml.html.includes(`<loc>${site}${legalPath('about')}</loc>`) &&
      !pagesXml.html.includes(`${site}/en${legalPath('about')}`),
  );

  const notFound = await page(`${base}/legal/nope`);
  check(
    'a 404 page carries the disclaimer too',
    notFound.status === 404 && notFound.html.includes(DISCLAIMER.uk),
  );

  const before = storedFiles();
  const odd = ['nope', 'Terms', 'terms.html', 'delivery_payment', 'x'.repeat(300), 'terms%00'];
  const codes: number[] = [];
  for (const word of odd) {
    codes.push((await page(`${base}/legal/${word}`)).status);
    codes.push((await page(`${base}/en/legal/${word}`)).status);
  }
  check(
    'unknown legal words are 404s',
    codes.every((code) => code === 404),
  );
  check('unknown legal words store nothing in .next', storedFiles() === before);

  const sitemap = await page(`${base}/sitemaps/pages.xml`);
  check(
    'the pages sitemap lists every legal page in both locales with a real lastmod and hreflang',
    LEGAL_KINDS.every(
      (kind) =>
        new RegExp(
          `<loc>${site}${legalPath(kind)}</loc><lastmod>\\d{4}-\\d{2}-\\d{2}T[\\d:]+Z</lastmod>`,
        ).test(sitemap.html) &&
        (kind === 'about' || sitemap.html.includes(`<loc>${site}/en${legalPath(kind)}</loc>`)),
    ) && sitemap.html.includes(`hreflang="en" href="${site}/en/legal/terms"`),
  );

  await runReturnPolicySmoke({ base, check });
}

const MESSAGES = { uk, en } as const;

/** The returns policy as a visitor and a crawler see it: the page summary, the product markup, the consent links. */
async function runReturnPolicySmoke({
  base,
  check,
}: Pick<Context, 'base' | 'check'>): Promise<void> {
  for (const locale of LEGAL_LOCALES) {
    const m = MESSAGES[locale].account;
    const returns = await page(`${base}${prefix(locale)}${legalPath('returns')}`);
    const text = returns.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    const accepted = ['defect', 'wrong_item', 'not_as_described'] as const;
    const refused = ['changed_mind', 'wrong_size', 'other'] as const;
    check(
      `returns ${locale}: the summary shows the window, Resolution 172, the accepted and the refused reasons`,
      returns.status === 200 &&
        text.includes(m.returnsPolicyStrict.replace('{days}', '14').replace(/\s+/g, ' ')) &&
        text.includes('172') &&
        accepted.every((r) => returns.html.includes(`data-reason="${r}">${m.reason[r]}`)) &&
        refused.every((r) => returns.html.includes(`data-reason="${r}">${m.reason[r]}`)) &&
        !/"@type":"FAQPage"/.test(returns.html),
    );
    const register = await page(`${base}${prefix(locale)}/account/register`);
    check(
      `register ${locale}: the consent line links the terms and the privacy policy`,
      register.status === 200 &&
        register.html.includes(`href="${prefix(locale)}${legalPath('terms')}"`) &&
        register.html.includes(`href="${prefix(locale)}${legalPath('privacy')}"`) &&
        !RAW_KEY.test(register.html.replace(/<[^>]*>/g, ' ')),
    );
  }

  // The class of a product decides whether its markup makes a claim: underwear (Resolution 172) says "not
  // permitted" with a link to the returns page; homewear carries no claim until the owner decides (Q79).
  const policy =
    '"hasMerchantReturnPolicy":{"@type":"MerchantReturnPolicy","applicableCountry":"UA","returnPolicyCategory":"https://schema.org/MerchantReturnNotPermitted","merchantReturnLink":"https://smoke.example/legal/returns"}';
  const ldOf = (html: string): string =>
    [...html.matchAll(/<script type="application\/ld\+json">([^<]*)<\/script>/g)]
      .map((m) => m[1] ?? '')
      .find((json) => json.includes('"@type":"Product"')) ?? '';
  const firstProductOf = async (category: string): Promise<string | undefined> =>
    /href="\/product\/([a-z0-9-]+)"/.exec((await page(`${base}/category/${category}`)).html)?.[1];
  const bra = await firstProductOf('bras');
  const pyjama = await firstProductOf('pyjamas');
  if (bra === undefined || pyjama === undefined) {
    check('a lingerie and a homewear product exist for the return policy markup check', false);
    return;
  }
  const braPage = await page(`${base}/product/${bra}`);
  const braSecond = await fetch(`${base}/product/${bra}`, {
    headers: { cookie: 'silk_cart=abc; silk_sizes=x', 'accept-language': 'en' },
  });
  const pyjamaLd = ldOf((await page(`${base}/product/${pyjama}`)).html);
  check(
    'a lingerie product carries hasMerchantReturnPolicy (not permitted, UA, link to the returns page), the same for every visitor; a homewear product carries none',
    ldOf(braPage.html).includes(policy) &&
      ldOf(braPage.html) === ldOf(await braSecond.text()) &&
      pyjamaLd.includes('"@type":"Product"') &&
      !pyjamaLd.includes('hasMerchantReturnPolicy'),
  );
  // The markup and the page say the same thing: "not permitted" in the markup means the returns page lists the refused reasons.
  const returnsUk = await page(`${base}${legalPath('returns')}`);
  check(
    'the markup says not permitted exactly where the returns page lists the refused reasons',
    ldOf(braPage.html).includes('MerchantReturnNotPermitted') &&
      returnsUk.html.includes('data-testid="refused-reasons"'),
  );

  // The trademark disclaimer is on EVERY kind of page, in both languages.
  const everywhere = [
    '/',
    '/category/bras',
    `/product/${bra}`,
    '/cart',
    '/checkout',
    '/search?q=bra',
    '/order/track',
    '/account/login',
    '/account/register',
    '/account/forgot',
    '/unsubscribe',
    '/nope',
  ];
  let missing = '';
  for (const locale of LEGAL_LOCALES) {
    for (const path of everywhere) {
      const url = `${base}${prefix(locale)}${path === '/' && locale === 'en' ? '' : path}`;
      // Redirects are followed: a page that sends the visitor elsewhere is judged by where it lands.
      const html = await (await fetch(url)).text();
      if (!html.includes(DISCLAIMER[locale]) && !html.includes(DISCLAIMER.uk)) missing += ` ${url}`;
    }
  }
  check(`the disclaimer is on every kind of page in both languages${missing}`, missing === '');
}
