import { describe, expect, it } from 'vitest';
import {
  containsRetiredTaxonomy,
  inlineField,
  mapWishlistTask,
  normaliseSentinel,
  parseKeyValueTable,
  parseWishlistBody,
  redactBody,
} from '@modules/sync/clickup/wishlist-mapper.js';
import type { ClickUpTask } from '@infra/clickup/client.js';

/**
 * Fixtures are the REAL bodies off list 901218207431, copied verbatim on
 * 2026-08-07. They are the corpus this parser exists to survive:
 *  - HR_SYSTEM      older template, `**OS Pillar:**`, no Year-review section
 *  - INVOICES       older template, Year-review AFTER the Submitter table,
 *                   `Urgency: —` and the `_Wish 1 of 1_` footer
 *  - WEBSITE        older template, `None` in every free-text answer
 *  - GROWTH_SPACED  newer template, `**Capability :**` (space before the colon)
 *  - GROWTH_TIGHT   newer template, `**Capability:**`
 */

const HR_SYSTEM = `## HR System

**OS Pillar:** ProductivityOS
**Urgency:** This quarter, it's blocking us
**Who feels the pain:** HR Department

* * *

### Problem

Pain in the ass

### Notes from submitter

Nothing

* * *

### Submitter

| Field | Value |
| ---| --- |
| Name | Maaz Ahmed |
| Role | CFO |
| Email | [m.ahmed@aidapt.co](mailto:m.ahmed@aidapt.co) |
| Company | Kenafric |
| Submitted at | 2026-05-21T07:13:46.302Z |`;

const INVOICES = `## Invoices

**OS Pillar:** Needs assignment (submitter chose "Not sure")
**Urgency:** —
**Who feels the pain:** asfsfs

* * *

### Problem

sdfasfgsd

### Notes from submitter

asfsdfgsd

* * *

### Submitter

| Field | Value |
| ---| --- |
| Name | Irtaza |
| Role | dfashdfs |
| Email | [s@aidapt.co](mailto:s@aidapt.co) |
| Company | Kenafric |
| Submitted at | 2026-05-20T18:48:04.028Z |

### Year-review priorities (top 3 across this submission)

dsfgsgfgs

* * *

_Wish 1 of 1 from this submission._`;

const WEBSITE = `## Website

**OS Pillar:** Needs assignment (submitter chose "Not sure")
**Urgency:** —
**Who feels the pain:** None

* * *

### Problem

None

### Notes from submitter

None

* * *

### Submitter

| Field | Value |
| ---| --- |
| Name | Ateeb |
| Role | Lead |
| Email | [m.ateeb@aidapt.co](mailto:m.ateeb@aidapt.co) |
| Company | Kenafric |
| Submitted at | 2026-05-20T18:34:27.505Z |

### Year-review priorities (top 3 across this submission)

None

* * *

_Wish 1 of 1 from this submission._`;

const GROWTH_SPACED = `## Growth

**Capability :** Intelligence
**Urgency:** This quarter, it's blocking us
**Who feels the pain:** CEo

* * *

### Problem

Need more leads

### Notes from submitter

Nothing

* * *

### Submitter

| Field | Value |
| ---| --- |
| Name | Sofi |
| Role | Ops |
| Email | [sofi@aidapt.co](mailto:sofi@aidapt.co) |
| Company | Aidapt |
| Submitted at | 2026-08-06T10:12:00.000Z |`;

const GROWTH_TIGHT = GROWTH_SPACED.replace('**Capability :** Intelligence', '**Capability:** DataOS');

describe('normaliseSentinel', () => {
  it('nulls the placeholders the form emits for an unanswered question', () => {
    for (const v of ['', '  ', '-', '--', '—', '–', 'N/A', 'na', 'None', 'none', 'TBD', 'Not sure', '?']) {
      expect(normaliseSentinel(v)).toBeNull();
    }
  });

  it('unwraps one layer of emphasis before deciding', () => {
    expect(normaliseSentinel('_None_')).toBeNull();
    expect(normaliseSentinel('**—**')).toBeNull();
    expect(normaliseSentinel('`n/a`')).toBeNull();
  });

  it('keeps "Nothing", which is a real answer and not a placeholder', () => {
    // Live value under "### Notes from submitter". Nulling it would eat content.
    expect(normaliseSentinel('Nothing')).toBe('Nothing');
  });

  it('keeps values that merely CONTAIN a sentinel word', () => {
    expect(normaliseSentinel('None of the stores can see stock')).toBe('None of the stores can see stock');
    expect(normaliseSentinel('Not sure yet, maybe Q3')).toBe('Not sure yet, maybe Q3');
  });
});

describe('inlineField', () => {
  it('reads a plain **Label:** value', () => {
    expect(inlineField(HR_SYSTEM, ['Urgency'])).toBe("This quarter, it's blocking us");
    expect(inlineField(HR_SYSTEM, ['Who feels the pain'])).toBe('HR Department');
  });

  it('tolerates a space before the colon, inside the bold', () => {
    // The newer template generation emits `**Capability :** Intelligence`.
    expect(inlineField(GROWTH_SPACED, ['Capability'])).toBe('Intelligence');
  });

  it('tolerates the colon outside the bold', () => {
    expect(inlineField('**Urgency**: Next quarter', ['Urgency'])).toBe('Next quarter');
  });

  it('tries labels in order and falls through misses', () => {
    expect(inlineField(HR_SYSTEM, ['Capability', 'OS Pillar'])).toBe('ProductivityOS');
  });

  it('returns null for an absent label and for a sentinel value', () => {
    expect(inlineField(HR_SYSTEM, ['Budget'])).toBeNull();
    expect(inlineField(INVOICES, ['Urgency'])).toBeNull();
  });
});

describe('parseKeyValueTable', () => {
  it('reads the Submitter table, skipping header and separator rows', () => {
    const t = parseKeyValueTable(`| Field | Value |
| ---| --- |
| Name | Maaz Ahmed |
| Role | CFO |`);
    expect(t.get('name')).toBe('Maaz Ahmed');
    expect(t.get('role')).toBe('CFO');
    expect(t.has('field')).toBe(false);
  });

  it('strips emphasis from keys so | **Name** | still matches', () => {
    expect(parseKeyValueTable('| **Name** | Layla |').get('name')).toBe('Layla');
  });
});

describe('parseWishlistBody', () => {
  it('parses the older template end to end', () => {
    const d = parseWishlistBody(HR_SYSTEM);
    expect(d.problem).toBe('Pain in the ass');
    expect(d.submitterNotes).toBe('Nothing');
    expect(d.whoFeelsPain).toBe('HR Department');
    expect(d.urgency).toBe("This quarter, it's blocking us");
    expect(d.submitterName).toBe('Maaz Ahmed');
    expect(d.submitterRole).toBe('CFO');
    expect(d.submitterEmail).toBe('m.ahmed@aidapt.co');
    expect(d.submitterCompany).toBe('Kenafric');
    expect(d.submittedAt).toBe('2026-05-21T07:13:46.302Z');
  });

  it('parses the newer template, whichever way the colon is spaced', () => {
    for (const body of [GROWTH_SPACED, GROWTH_TIGHT]) {
      const d = parseWishlistBody(body);
      expect(d.problem).toBe('Need more leads');
      expect(d.whoFeelsPain).toBe('CEo');
      expect(d.submitterName).toBe('Sofi');
    }
  });

  it('does not let a Year-review section bleed into the Submitter table', () => {
    // It sits AFTER "### Submitter" on 5 of 14 live tasks, so slicing to the next
    // KNOWN heading would swallow it and corrupt the submitter fields.
    const d = parseWishlistBody(INVOICES);
    expect(d.submitterName).toBe('Irtaza');
    expect(d.submitterCompany).toBe('Kenafric');
    expect(d.submittedAt).toBe('2026-05-20T18:48:04.028Z');
    expect(d.problem).toBe('sdfasfgsd');
    expect(d.submitterNotes).toBe('asfsdfgsd');
  });

  it('nulls every free-text answer that came back as a placeholder', () => {
    const d = parseWishlistBody(WEBSITE);
    expect(d.problem).toBeNull();
    expect(d.submitterNotes).toBeNull();
    expect(d.whoFeelsPain).toBeNull();
    expect(d.urgency).toBeNull();
    // The submitter block is machine-generated, so it still parses.
    expect(d.submitterName).toBe('Ateeb');
  });

  it('never returns a retired-taxonomy value in ANY field, body_md included', () => {
    for (const body of [HR_SYSTEM, INVOICES, WEBSITE, GROWTH_SPACED, GROWTH_TIGHT]) {
      const d = parseWishlistBody(body);
      const joined = [
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
      expect(containsRetiredTaxonomy(joined)).toBe(false);
    }
  });

  it('drops the pillar line and the generated footer from body_md', () => {
    const body = parseWishlistBody(INVOICES).bodyMd!;
    expect(body).not.toMatch(/OS Pillar/i);
    expect(body).not.toMatch(/Wish 1 of 1/i);
    // What survives is only what has no column of its own — here the optional
    // "Year-review priorities" block. `problem` etc. are returned as fields, so
    // repeating them in the fallback would render them twice.
    expect(body).toContain('Year-review priorities');
    expect(parseWishlistBody(INVOICES).problem).toBe('sdfasfgsd');
  });

  it('leaves body_md null when the whole body parsed into fields', () => {
    expect(parseWishlistBody(HR_SYSTEM).bodyMd).toBeNull();
  });

  it('rejects a submitted-at that is not a real date, and a malformed email', () => {
    const d = parseWishlistBody(`### Submitter

| Field | Value |
| ---| --- |
| Email | not-an-email |
| Submitted at | whenever |`);
    expect(d.submittedAt).toBeNull();
    expect(d.submitterEmail).toBeNull();
  });

  it('accepts a bare email address as well as a mailto link', () => {
    const d = parseWishlistBody('### Submitter\n\n| Email | Layla@Vivo.COM |');
    expect(d.submitterEmail).toBe('layla@vivo.com');
  });

  it('returns all nulls for an empty body rather than throwing', () => {
    for (const v of [null, undefined, '', '   \n  ']) {
      const d = parseWishlistBody(v);
      expect(d.problem).toBeNull();
      expect(d.submitterName).toBeNull();
      expect(d.bodyMd).toBeNull();
    }
  });

  it('keeps an unrecognised body verbatim in body_md so nothing is lost', () => {
    const d = parseWishlistBody('We just need the invoices thing sorted out, please.');
    expect(d.problem).toBeNull();
    expect(d.bodyMd).toBe('We just need the invoices thing sorted out, please.');
  });

  it('handles CRLF line endings', () => {
    expect(parseWishlistBody(HR_SYSTEM.replace(/\n/g, '\r\n')).problem).toBe('Pain in the ass');
  });
});

describe('redactBody', () => {
  it('collapses the blank lines left behind by a removed line', () => {
    expect(redactBody('a\n\n**OS Pillar:** DataOS\n\nb')).toBe('a\n\nb');
  });

  it('drops inline fields whose value is a placeholder', () => {
    // Otherwise the fallback renders "Urgency: —" straight at the client, which is
    // exactly what nulling the sentinels in the parsed fields exists to prevent.
    const out = redactBody(WEBSITE);
    expect(out).not.toMatch(/Urgency/);
    expect(out).not.toMatch(/Who feels the pain/);
  });

  it('drops every section that has its own parsed column', () => {
    // body_md is the fallback for what we could NOT parse. Keeping Problem or the
    // Submitter table here would render them twice, since each has its own section.
    for (const body of [HR_SYSTEM, INVOICES, WEBSITE, GROWTH_SPACED]) {
      const out = redactBody(body);
      expect(out).not.toMatch(/### Problem/);
      expect(out).not.toMatch(/Notes from submitter/);
      expect(out).not.toMatch(/### Submitter/);
      expect(out).not.toMatch(/Urgency/);
      expect(out).not.toMatch(/Who feels the pain/);
    }
  });

  it('is empty for a body the parser fully understood', () => {
    // Every live task matches the template, so none of them carries a fallback.
    for (const body of [HR_SYSTEM, WEBSITE, GROWTH_SPACED, GROWTH_TIGHT]) {
      expect(redactBody(body)).toBe('');
    }
  });

  it('keeps a section the parser has no column for', () => {
    // e.g. the optional "Year-review priorities" block, when it has real content.
    const out = redactBody(INVOICES);
    expect(out).toContain('Year-review priorities');
    expect(out).toContain('dsfgsgfgs');
  });

  it('drops the leading request title, which the UI already shows above the body', () => {
    expect(redactBody(`## Website\n\nSome free text.`)).toBe('Some free text.');
  });

  it('leaves no stranded horizontal rule at either end', () => {
    const out = redactBody(INVOICES);
    expect(out.startsWith('*')).toBe(false);
    expect(out.endsWith('*')).toBe(false);
  });

  it('leaves a body with no form structure untouched', () => {
    expect(redactBody('Just fix the invoices please.')).toBe('Just fix the invoices please.');
  });
});

describe('mapWishlistTask', () => {
  const task = (over: Partial<ClickUpTask> = {}): ClickUpTask => ({
    id: '869dcwxtv',
    name: 'Kenafric - HR System',
    markdown_description: HR_SYSTEM,
    date_created: '1779347629892',
    ...over,
  });

  it('maps id, title, created date and the parsed detail', () => {
    const row = mapWishlistTask(task(), { tenantId: 'ten-1' });
    expect(row).toMatchObject({
      tenantId: 'ten-1',
      clickupTaskId: '869dcwxtv',
      title: 'Kenafric - HR System',
      createdAt: new Date(1779347629892).toISOString(),
    });
    expect(row.detail.submitterName).toBe('Maaz Ahmed');
  });

  it('falls back to `description` when markdown is absent', () => {
    const row = mapWishlistTask(
      task({ markdown_description: null, description: HR_SYSTEM }),
      { tenantId: 'ten-1' },
    );
    expect(row.detail.problem).toBe('Pain in the ass');
  });

  it('leaves createdAt null when ClickUp sent no date', () => {
    expect(mapWishlistTask(task({ date_created: undefined }), { tenantId: 't' }).createdAt).toBeNull();
  });
});
