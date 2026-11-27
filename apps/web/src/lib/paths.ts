import { legalPath, type LegalKind } from '@store/shared/legal';
import { localizedPath, type SiteLocale } from '@store/shared/seo';

/** Locale-less storefront paths; `href` adds the locale prefix. */
export const paths = {
  home: '/',
  category: (slug: string): string => `/category/${slug}`,
  product: (slug: string): string => `/product/${slug}`,
  search: '/search',
  cart: '/cart',
  checkout: '/checkout',
  orderSuccess: '/order/success',
  orderFailed: '/order/failed',
  orderTrack: '/order/track',
  account: '/account',
  accountOrders: '/account/orders',
  accountOrder: (number: string): string => `/account/orders/${number}`,
  accountReturns: '/account/returns',
  accountReviews: '/account/reviews',
  accountWishlist: '/account/wishlist',
  blog: '/blog',
  blogPost: (slug: string): string => `/blog/${slug}`,
  blogTag: (tag: string): string => `/blog/tag/${tag}`,
  legal: (kind: LegalKind): string => legalPath(kind),
  unsubscribe: '/unsubscribe',
  unsubscribeMarketing: '/unsubscribe/marketing',
  newsletter: '/newsletter',
  newsletterConfirm: '/newsletter/confirm',
  accountProfile: '/account/profile',
  accountAddresses: '/account/addresses',
  accountLogin: '/account/login',
  accountRegister: '/account/register',
  accountForgot: '/account/forgot',
  accountSetPassword: '/account/set-password',
} as const;

export const href = (locale: SiteLocale, path: string, search = ''): string =>
  `${localizedPath(locale, path)}${search === '' ? '' : `?${search}`}`;
