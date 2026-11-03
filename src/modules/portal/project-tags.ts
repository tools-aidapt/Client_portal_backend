/** Badge tones, identical to the CHECK on portal.task_statuses.tone (0044). */
export const TAG_TONES = ['neutral', 'info', 'warning', 'error', 'success', 'teal'] as const;
export type TagTone = (typeof TAG_TONES)[number];

export const MAX_TAGS_PER_PROJECT = 8;

export interface ProjectTag {
  id: string;
  key: string;
  label: string;
  tone: string;
  is_primary: boolean;
}

/** "Go-live" -> "go-live", "Phase 2!" -> "phase-2". Empty when nothing usable remains. */
export function slugifyTagKey(label: string): string {
  return label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Check a tag selection: no duplicates, the primary (when given) is among the
 * selected tags, and a primary cannot exist on an empty set. Returns an error
 * message, or null when valid.
 */
export function tagSelectionError(tagIds: string[], primaryTagId: string | null): string | null {
  if (new Set(tagIds).size !== tagIds.length) return 'tag_ids must not contain duplicates';
  if (primaryTagId !== null && !tagIds.includes(primaryTagId)) {
    return 'primary_tag_id must be one of tag_ids';
  }
  return null;
}

/** The project's accent: its primary tag's tone, else its status tone. */
export function accentTone(tags: ProjectTag[], statusTone: string | null | undefined): string | null {
  return tags.find((t) => t.is_primary)?.tone ?? statusTone ?? null;
}
