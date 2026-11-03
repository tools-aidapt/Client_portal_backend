export type ProjectCapability = 'operations' | 'intelligence' | 'enablement';

// Longest alternatives first so "Operations" is not read as "Ops" + "erations".
// A separator (dash, en/em dash, colon, pipe or plain space) is required, so a
// name that merely starts with the letters ("Opsworks") is left alone.
const PREFIX = /^\s*(operations|ops|intelligence|intel|intl|int|enablement|enable)(?:\s*[-\u2013\u2014:|]\s*|\s+)([^\s\-\u2013\u2014:|].*)$/i;

const CAPABILITY: Record<string, ProjectCapability> = {
  ops: 'operations',
  operations: 'operations',
  intel: 'intelligence',
  intelligence: 'intelligence',
  intl: 'intelligence',
  int: 'intelligence',
  enable: 'enablement',
  enablement: 'enablement',
};

/**
 * Split a ClickUp list name like "Ops - Invoice Automation" into the capability
 * it names and the name to show. Names without a recognised prefix come back
 * unchanged with a null capability.
 */
export function parseProjectName(name: string): { display_name: string; capability: ProjectCapability | null } {
  const m = PREFIX.exec(name);
  if (!m) return { display_name: name, capability: null };
  return { display_name: m[2]!.trim(), capability: CAPABILITY[m[1]!.toLowerCase()]! };
}
