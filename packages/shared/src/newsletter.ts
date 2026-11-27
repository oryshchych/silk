/**
 * The consent wording a subscriber saw is versioned: the audit row of a subscription records the version, so
 * "what exactly did this person agree to" can be answered later. Change the text in `messages/*.json` AND bump
 * this constant together (a test pins that the two locales carry the same version key).
 */
export const NEWSLETTER_CONSENT_VERSION = 'v1';
