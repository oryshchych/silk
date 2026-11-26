/**
 * Reviews as served. Explicit field lists (zod drops unknown keys): the PUBLIC view has no customer id,
 * no e-mail, no order id, no moderation data; the ADMIN view adds what a moderator needs (never the customer's e-mail: moderation does not need it, and the `content` role sees no customer data).
 */
import { z } from 'zod';

export const fitValues = ['small', 'true_to_size', 'large'] as const;

export const publicReviewDto = z.object({
  rating: z.number().int().min(1).max(5),
  title: z.string().nullable(),
  body: z.string().nullable(),
  /** "Iryna K." or null: first name and the initial of the last one, never the e-mail. */
  author: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  /** The size on the VERIFIED order line, never a claim of the reviewer. */
  sizeBought: z.string().nullable(),
  fit: z.enum(fitValues).nullable(),
  adminReply: z.string().nullable(),
});

export const fitSummaryDto = z.object({
  /** Share of reviewers who say it fits, 0 to 100. */
  truePercent: z.number().int().min(0).max(100),
  total: z.number().int().positive(),
});

export const adminReviewDto = z.object({
  id: z.uuid(),
  productId: z.uuid(),
  productName: z.string(),
  productSlug: z.string(),
  rating: z.number().int().min(1).max(5),
  title: z.string().nullable(),
  body: z.string().nullable(),
  sizeBought: z.string().nullable(),
  fit: z.enum(fitValues).nullable(),
  status: z.enum(['pending', 'approved', 'rejected']),
  adminReply: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});

export type PublicReviewDto = z.output<typeof publicReviewDto>;
export type FitSummaryDto = z.output<typeof fitSummaryDto>;
export type AdminReviewDto = z.output<typeof adminReviewDto>;
