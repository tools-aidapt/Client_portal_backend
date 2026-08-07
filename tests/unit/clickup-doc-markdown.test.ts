import { describe, expect, it } from 'vitest';
import { normalizeDocMarkdown, parseTrackerCounts } from '@modules/sync/clickup/mapper.js';

// These two guard live behaviour that survived the move from bi-weekly Doc pages
// to monthly Docs: the Action Item Tracker still shifts its columns between
// reports, and ClickUp still exports paragraph runs without hard breaks.

describe('parseTrackerCounts', () => {
  // Report 1's tracker: 4 columns, no Source/Due.
  const reportOneShape = `
## 3\\. Action Item Tracker

| # | Action Item | Owner | Status |
| ---| ---| ---| --- |
| 1 | Provision server | James | 🔄 In Progress |
| 2 | Confirm scope | All | ✅ Done |

## 4\\. Risks and Issues
`;

  // Report 9's tracker: Source and Due inserted, so Status moves position.
  const reportNineShape = `
## 3\\. Action Item Tracker

| # | Action Item | Owner | Source | Status | Due |
| ---| ---| ---| ---| ---| --- |
| 64 | Compile inventory | Narayanan | Report 5 | ✅ Done — scope locked | 02 Jul |
| 78 | Send fields doc | Sushil | Report 6 | 🔄 In Progress — carried | 15 Jul |
| 95 | Build KIL dashboard | Sushil | Report 9 | ⏳ Not Started | 25 Jul |

## 4\\. Risks and Issues

| # | Risk | Status |
| ---| ---| --- |
| 1 | Blocker cleared | ✅ Resolved |
| 2 | Another one cleared | ✅ Resolved |
`;

  it('counts every tracked action as committed and ✅ rows as delivered', () => {
    expect(parseTrackerCounts(reportOneShape)).toEqual({ committed: 2, delivered: 1 });
  });

  it('locates the status column by header name, not position', () => {
    expect(parseTrackerCounts(reportNineShape)).toEqual({ committed: 3, delivered: 1 });
  });

  it('ignores ✅ in the Risks table that follows the tracker', () => {
    // Two ✅ Resolved risks must not inflate delivered beyond the one ✅ action.
    expect(parseTrackerCounts(reportNineShape)?.delivered).toBe(1);
  });

  it('returns null when there is no tracker to read', () => {
    expect(parseTrackerCounts('## 1. What We Did\n\nProse only.')).toBeNull();
    expect(parseTrackerCounts('## 3. Action Item Tracker\n\nNone this period.\n')).toBeNull();
  });
});


describe('normalizeDocMarkdown', () => {
  it('hard-breaks the report header so it does not render as one run-on line', () => {
    const header = [
      '**Project:** AI Data Cloud (Snowflake Implementation)',
      '**Client:** Kenafric Group',
      '**Date:** 02 July 2026',
    ].join('\r\n');
    expect(normalizeDocMarkdown(header)).toBe(
      '**Project:** AI Data Cloud (Snowflake Implementation)  \n' +
        '**Client:** Kenafric Group  \n' +
        '**Date:** 02 July 2026',
    );
  });

  it('normalises CRLF to LF', () => {
    expect(normalizeDocMarkdown('# Heading\r\n\r\nBody.\r\n')).toBe('# Heading\n\nBody.\n');
  });

  it('leaves tables, lists and headings byte-for-byte alone', () => {
    const md = [
      '## 3. Action Item Tracker',
      '',
      '| # | Status |',
      '| ---| --- |',
      '| 1 | ✅ Done |',
      '',
      '- [ ] Ship the dashboard',
      '- [x] Close the blocker',
      '',
      '* * *',
    ].join('\n');
    expect(normalizeDocMarkdown(md)).toBe(md);
  });

  it('does not hard-break a single-line paragraph', () => {
    expect(normalizeDocMarkdown('Just one line.\n\nAnd another.')).toBe('Just one line.\n\nAnd another.');
  });

  it('never touches content inside a fenced code block', () => {
    // Report 2's architecture diagram ships pre-fenced from ClickUp; adding hard
    // breaks inside it would render literal trailing spaces in the code block.
    const md = [
      '```markdown',
      'SAP S/4 HANA 1909',
      '        ↓ HANA Cloud Connector',
      '   Data Sphere',
      '```',
    ].join('\n');
    expect(normalizeDocMarkdown(md)).toBe(md);
  });

  it('is idempotent', () => {
    const md = '**A:** one\r\n**B:** two\r\n\r\n| x |\n| --- |\n| y |\n';
    const once = normalizeDocMarkdown(md);
    expect(normalizeDocMarkdown(once)).toBe(once);
  });
});

