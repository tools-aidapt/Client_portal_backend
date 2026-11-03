export type ProjectCapability = 'operations' | 'intelligence' | 'enablement' | 'operations_intelligence';

// Longest alternatives first so "Operations" is not read as "Ops" + "erations".
// A separator (dash, en/em dash, colon, pipe or plain space) is required, so a
// name that merely starts with the letters ("Opsworks") is left alone.
const SEP = String.raw`(?:\s*[-\u2013\u2014:|]\s*|\s+)([^\s\-\u2013\u2014:|].*)$`;
const PREFIX = new RegExp(String.raw`^\s*(operations|ops|intelligence|intel|intl|int|enablement|enable)${SEP}`, 'i');

// Combined "Operations / Intelligence" prefix: an ops word and an int word, in
// either order, joined by / & + , or "and" (spaces optional around symbols).
const OPS_WORD = 'operations|ops';
const INT_WORD = 'intelligence|intel|intl|int';
const JOIN = String.raw`(?:\s*[/&+,]\s*|\s+and\s+)`;
const COMBINED = [
  new RegExp(String.raw`^\s*(?:${OPS_WORD})${JOIN}(?:${INT_WORD})${SEP}`, 'i'),
  new RegExp(String.raw`^\s*(?:${INT_WORD})${JOIN}(?:${OPS_WORD})${SEP}`, 'i'),
];

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
  for (const re of COMBINED) {
    const c = re.exec(name);
    if (c) return { display_name: c[1]!.trim(), capability: 'operations_intelligence' };
  }
  const m = PREFIX.exec(name);
  if (!m) return { display_name: name, capability: null };
  return { display_name: m[2]!.trim(), capability: CAPABILITY[m[1]!.toLowerCase()]! };
}
