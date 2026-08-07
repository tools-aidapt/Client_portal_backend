/* Read-only: fetch every task on the shared wishlist list and run the parser over
 * it, reporting per-field coverage. Touches no database and writes nothing to
 * ClickUp — this is the check that the intake-form parser actually handles the
 * live corpus before the sync starts persisting its output.
 *
 * Run: npx tsx scripts/smoke-wishlist-parse.ts
 */
import 'dotenv/config';
import { ClickUpClient } from '../src/infra/clickup/client.js';
import { WISHLIST_LIST_ID } from '../src/modules/sync/clickup/sync.constants.js';
import { extractClientGroup } from '../src/modules/sync/clickup/mapper.js';
import {
  containsRetiredTaxonomy,
  parseWishlistBody,
} from '../src/modules/sync/clickup/wishlist-mapper.js';

const client = new ClickUpClient();
const tasks = await client.getListTasks(WISHLIST_LIST_ID);

console.log(`list ${WISHLIST_LIST_ID}: ${tasks.length} tasks`);
console.log(`subtasks (would be skipped): ${tasks.filter((t) => t.parent).length}`);
console.log(`no markdown body: ${tasks.filter((t) => !t.markdown_description).length}`);
console.log(`no Client Group (unroutable): ${tasks.filter((t) => !extractClientGroup(t)).length}`);

const FIELDS = [
  'problem',
  'whoFeelsPain',
  'urgency',
  'submitterNotes',
  'submitterName',
  'submitterRole',
  'submitterEmail',
  'submitterCompany',
  'submittedAt',
] as const;

const coverage = new Map<string, number>(FIELDS.map((f) => [f, 0]));
let leaks = 0;
let fallbackOnly = 0;

console.log('\nper task:');
for (const task of tasks) {
  const d = parseWishlistBody(task.markdown_description ?? task.description ?? null);
  for (const f of FIELDS) if (d[f]) coverage.set(f, coverage.get(f)! + 1);
  if (!d.problem) fallbackOnly++;

  // The acceptance test: retired taxonomy must not survive into ANY stored field.
  const stored = [
    d.problem,
    d.whoFeelsPain,
    d.urgency,
    d.submitterNotes,
    d.submitterName,
    d.submitterRole,
    d.submitterCompany,
    d.bodyMd,
  ]
    .filter(Boolean)
    .join(' ');
  const leaked = containsRetiredTaxonomy(stored);
  if (leaked) leaks++;

  const missing = FIELDS.filter((f) => !d[f]);
  console.log(
    `  ${task.id} ${(task.name ?? '').slice(0, 34).padEnd(34)} ` +
      `group=${(extractClientGroup(task) ?? '—').padEnd(18)} ` +
      `${leaked ? 'RETIRED-LEAK ' : ''}${missing.length ? `null: ${missing.join(',')}` : 'all fields parsed'}`,
  );
}

console.log('\ncoverage:');
for (const f of FIELDS) console.log(`  ${f.padEnd(18)} ${coverage.get(f)}/${tasks.length}`);
console.log(`\nrows that would carry body_md fallback (problem null): ${fallbackOnly}/${tasks.length}`);
console.log(`retired-taxonomy leaks: ${leaks} (MUST be 0)`);
if (leaks > 0) process.exit(1);
