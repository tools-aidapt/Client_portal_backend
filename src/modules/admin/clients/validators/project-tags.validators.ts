import { z } from 'zod';
import { MAX_TAGS_PER_PROJECT, TAG_TONES, slugifyTagKey, tagSelectionError } from '@modules/portal/project-tags.js';

export const createTagBody = z.object({
  label: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .refine((l) => slugifyTagKey(l).length > 0, 'label must contain letters or numbers'),
  tone: z.enum(TAG_TONES),
});

/** `tag_ids` replaces the project's whole set; `primary_tag_id` must be one of them. */
export const setProjectTagsBody = z
  .object({
    tag_ids: z.array(z.string().uuid()).max(MAX_TAGS_PER_PROJECT),
    primary_tag_id: z.string().uuid().nullable(),
  })
  .superRefine((b, ctx) => {
    const msg = tagSelectionError(b.tag_ids, b.primary_tag_id);
    if (msg) ctx.addIssue({ code: z.ZodIssueCode.custom, message: msg, path: ['primary_tag_id'] });
  });
