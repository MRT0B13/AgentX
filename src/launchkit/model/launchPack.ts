import { z } from 'zod';

const isoDateTime = z.string().datetime({ offset: true });

export const memeSchema = z
  .object({
    url: z.string().url('memes.url must be a valid URL'),
    caption: z.string().trim().optional().default(''),
  })
  .strict();

export const scheduleItemSchema = z
  .object({
    when: isoDateTime,
    text: z.string().trim().min(1, 'schedule.text is required'),
    media_url: z.string().url().optional(),
  })
  .strict();

export const brandSchema = z
  .object({
    name: z.string().trim().min(1, 'brand.name is required'),
    ticker: z
      .string()
      .trim()
      .min(1, 'brand.ticker is required')
      .max(12, 'brand.ticker must be <= 12 chars')
      .transform((val: string) => val.toUpperCase()),
    tagline: z.string().trim().optional().default(''),
    description: z.string().trim().optional().default(''),
    lore: z.string().trim().optional().default(''),
  })
  .strict();

export const linksSchema = z
  .object({
    telegram: z.string().url().optional(),
    x: z.string().url().optional(),
    website: z.string().url().optional(),
  })
  .strict();

export const assetsSchema = z
  .object({
    logo_url: z.string().url().optional(),
    banner_url: z.string().url().optional(),
    memes: z.array(memeSchema).optional().default([]),
  })
  .strict();

export const tgPinsSchema = z
  .object({
    welcome: z.string().trim().optional().default(''),
    how_to_buy: z.string().trim().optional().default(''),
    memekit: z.string().trim().optional().default(''),
  })
  .strict();

export const tgSchema = z
  .object({
    chat_id: z.string().trim().optional(),
    pins: tgPinsSchema.optional().default(() => ({ welcome: '', how_to_buy: '', memekit: '' })),
    schedule: z.array(scheduleItemSchema).optional().default(() => []),
  })
  .strict();

export const xSchema = z
  .object({
    main_post: z.string().trim().optional().default(''),
    thread: z.array(z.string().trim()).optional().default(() => []),
    reply_bank: z.array(z.string().trim()).optional().default(() => []),
    schedule: z.array(scheduleItemSchema).optional().default(() => []),
  })
  .strict();

export const launchStatusSchema = z.enum(['draft', 'ready', 'launched', 'failed']);

export const launchSchema = z
  .object({
    status: launchStatusSchema.default('draft'),
    mint: z.string().trim().optional(),
    tx_signature: z.string().trim().optional(),
    pump_url: z.string().url().optional(),

    requested_at: isoDateTime.optional(),
    completed_at: isoDateTime.optional(),
    launched_at: isoDateTime.optional(),
    failed_at: isoDateTime.optional(),

    error_code: z.string().trim().optional(),
    error_message: z.string().trim().optional(),
  })
  .strict();

export const auditEntrySchema = z
  .object({
    at: isoDateTime.optional(),
    message: z.string().trim().min(1, 'audit message is required'),
    actor: z.string().trim().optional(),
  })
  .strict();

export const opsSchema = z
  .object({
    checklist: z.record(z.string(), z.boolean()).optional().default(() => ({})),
    audit_log: z.array(auditEntrySchema).optional().default(() => []),
    tg_publish_status: z.enum(['idle', 'in_progress', 'published', 'failed']).optional(),
    tg_publish_attempted_at: isoDateTime.optional(),
    tg_publish_failed_at: isoDateTime.optional(),
    tg_publish_error_code: z.string().trim().nullable().optional(),
    tg_publish_error_message: z.string().trim().nullable().optional(),
    tg_published_at: isoDateTime.optional(),
    tg_message_ids: z.array(z.string().trim()).optional(),
    tg_schedule_intent: z.array(scheduleItemSchema).optional(),
    x_publish_status: z.enum(['idle', 'in_progress', 'published', 'failed']).optional(),
    x_publish_attempted_at: isoDateTime.optional(),
    x_publish_failed_at: isoDateTime.optional(),
    x_publish_error_code: z.string().trim().nullable().optional(),
    x_publish_error_message: z.string().trim().nullable().optional(),
    x_published_at: isoDateTime.optional(),
    x_post_ids: z.array(z.string().trim()).optional(),
    x_tweet_ids: z.array(z.string().trim()).optional(),
    x_schedule_intent: z.array(scheduleItemSchema).optional(),
  })
  .strict();

export const launchPackSchema = z
  .object({
    id: z.string().uuid().optional(),
    idempotency_key: z.string().trim().min(8).optional(),
    version: z.number().int().min(1).optional().default(1),
    brand: brandSchema,
    links: linksSchema.optional().default(() => ({})),
    assets: assetsSchema.optional().default(() => ({ memes: [] })),
    tg: tgSchema.optional().default(() => ({ pins: { welcome: '', how_to_buy: '', memekit: '' }, schedule: [] })),
    x: xSchema.optional().default(() => ({ main_post: '', thread: [], reply_bank: [], schedule: [] })),
    launch: launchSchema.optional().default(() => ({ status: 'draft' as const })),
    ops: opsSchema.optional().default(() => ({ checklist: {}, audit_log: [] })),
    created_at: isoDateTime.optional(),
    updated_at: isoDateTime.optional(),
  })
  .strict();

export const createLaunchPackSchema = launchPackSchema
  .omit({ created_at: true, updated_at: true })
  .extend({ id: z.string().uuid().optional() })
  .strict();

export const updateLaunchPackSchema = launchPackSchema
  .omit({ id: true, created_at: true, updated_at: true })
  .partial()
  .strict();

export type LaunchPack = z.infer<typeof launchPackSchema> & { id: string };
export type LaunchPackCreateInput = z.input<typeof createLaunchPackSchema>;
export type LaunchPackUpdateInput = z.input<typeof updateLaunchPackSchema>;

export const LaunchPackValidation = {
  create(input: unknown) {
    return createLaunchPackSchema.parse(input);
  },
  update(input: unknown) {
    return updateLaunchPackSchema.parse(input);
  },
};
