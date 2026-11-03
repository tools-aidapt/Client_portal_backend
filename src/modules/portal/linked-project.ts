import type { ProjectCapability } from './project-name.js';

/** The slice of a `portalService.projects()` row a linked_project is built from. */
export interface LinkableProject {
  clickup_list_id: string;
  display_name: string;
  status_key: string | null;
  status_label: string | null;
  status_tone?: string | null;
  capability?: ProjectCapability | null;
  progress_pct: number | null;
}

export interface LinkedProject {
  list_id: string;
  name: string;
  status_key: string | null;
  status_label: string | null;
  status_tone: string | null;
  progress_pct: number | null;
  capability: ProjectCapability | null;
}

/**
 * The compact project card embedded on a wishlist item or an onboarding request.
 * Shared so a linked project reads identically wherever it appears.
 */
export function buildLinkedProject(p: LinkableProject | undefined): LinkedProject | null {
  if (!p) return null;
  return {
    list_id: p.clickup_list_id,
    name: p.display_name,
    status_key: p.status_key,
    status_label: p.status_label,
    status_tone: p.status_tone ?? null,
    capability: p.capability ?? null,
    progress_pct: p.progress_pct,
  };
}
