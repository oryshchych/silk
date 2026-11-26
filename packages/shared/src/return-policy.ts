/**
 * ONE description of the returns policy: the returns page summary, the return request form, the server's check
 * of a request and the `hasMerchantReturnPolicy` JSON-LD on every product page are all built from THIS object, so
 * they cannot drift (a test compares them, `return-policy-consistency.unit.test.ts`). Owner queue Q75.
 *
 * What it says (a DRAFT, needs a lawyer):
 *  - Underwear and hosiery of proper quality are not subject to exchange or return (Cabinet of Ministers
 *    Resolution No. 172 of 19 March 1994), so a request because of a change of mind, a wrong size or "other" is
 *    NOT accepted (`voluntaryReturns: false`).
 *  - A defect, a wrong item and an item that does not match its description are separate legal regimes and are
 *    accepted within the window, for every product. A manager reviews each request.
 * Flipping `voluntaryReturns` (a lawyer's decision, possibly per product class later) makes the form accept the
 * voluntary reasons, the page summary say so, and the JSON-LD become a finite return window.
 */
export const REASONS_ACCEPTED_BY_LAW = ['defect', 'wrong_item', 'not_as_described'] as const;
export const REASONS_VOLUNTARY = ['changed_mind', 'wrong_size', 'other'] as const;
export type ReturnReasonValue =
  (typeof REASONS_ACCEPTED_BY_LAW)[number] | (typeof REASONS_VOLUNTARY)[number];

export interface ReturnPolicy {
  /** ISO country the policy applies to. */
  applicableCountry: string;
  /** Days after DELIVERY a request is accepted (`settings.return_window_days` may override it, within 0 to 365). */
  defaultWindowDays: number;
  /** Does the shop accept a return of an item of proper quality (changed mind, wrong size, other)? */
  voluntaryReturns: boolean;
  /** schema.org `ReturnMethodEnumeration` and `ReturnFeesEnumeration`, used only when returns are permitted. */
  returnMethod: 'ReturnByMail';
  returnFees: 'ReturnShippingFees';
}

export const RETURN_POLICY: ReturnPolicy = {
  applicableCountry: 'UA',
  defaultWindowDays: 14,
  voluntaryReturns: false,
  returnMethod: 'ReturnByMail',
  returnFees: 'ReturnShippingFees',
};

/** The reasons a request may carry under a policy, in the order the form lists them. */
export function acceptedReturnReasons(
  policy: Pick<ReturnPolicy, 'voluntaryReturns'> = RETURN_POLICY,
): readonly ReturnReasonValue[] {
  return policy.voluntaryReturns
    ? [...REASONS_ACCEPTED_BY_LAW, ...REASONS_VOLUNTARY]
    : REASONS_ACCEPTED_BY_LAW;
}

export const isReasonAccepted = (
  reason: string,
  policy: Pick<ReturnPolicy, 'voluntaryReturns'> = RETURN_POLICY,
): boolean => acceptedReturnReasons(policy).some((accepted) => accepted === reason);

/**
 * Product classes (owner queue Q79, needs a lawyer). Resolution No. 172 covers underwear and hosiery, not
 * homewear, and a distance-sale withdrawal right may apply to homewear, so the markup makes a claim ONLY for the
 * classes the Resolution names. Until the owner and a lawyer decide homewear, a homewear product carries NO
 * `hasMerchantReturnPolicy` (silence, not a claim that may be wrong). The category slugs are the ROOT or LEAF
 * slugs of the catalogue tree (`lingerie` and everything under it are underwear; socks and hosiery too).
 */
export const NON_RETURNABLE_CATEGORY_SLUGS: readonly string[] = [
  'lingerie',
  'bras',
  'panties',
  'sets',
  'hosiery',
  'socks',
  'tights',
];

/** True when any category of the product's breadcrumb (root to leaf) is one the Resolution names. */
export const isNonReturnableClass = (categorySlugs: readonly string[]): boolean =>
  categorySlugs.some((slug) => NON_RETURNABLE_CATEGORY_SLUGS.includes(slug));
