import { describe, expect, it } from 'vitest';
import { toTsQuery } from '@modules/usecases/usecases.service.js';
import { parseCaseStudySections } from '@modules/sync/clickup/usecase-mapper.js';

describe('toTsQuery', () => {
  it('prefix-matches the last term so search works while typing', () => {
    expect(toTsQuery('insur')).toBe('insur:*');
    expect(toTsQuery('freight invoice')).toBe('freight & invoice:*');
  });

  it('ANDs every term so more words narrow the result', () => {
    expect(toTsQuery('reduce manual invoice processing')).toBe('reduce & manual & invoice & processing:*');
  });

  it('strips tsquery operators instead of passing them through', () => {
    // Unsanitised, these would either be parsed as operators or throw a syntax
    // error inside to_tsquery.
    expect(toTsQuery('claims & !fraud')).toBe('claims & fraud:*');
    expect(toTsQuery('ai | agent:* & (fraud)')).toBe('ai & agent & fraud:*');
    // The apostrophe splits the word, and the lone "o" is dropped as noise.
    expect(toTsQuery("o'brien & co")).toBe('brien & co:*');
    // An expression made only of operators and single letters has nothing to
    // search on, so it degrades to browsing rather than erroring.
    expect(toTsQuery('a | b:* & (c)')).toBeNull();
  });

  it('returns null when there is nothing searchable, so the caller browses all', () => {
    expect(toTsQuery(undefined)).toBeNull();
    expect(toTsQuery(null)).toBeNull();
    expect(toTsQuery('')).toBeNull();
    expect(toTsQuery('   ')).toBeNull();
    expect(toTsQuery('+++---&&')).toBeNull();
    expect(toTsQuery('!@#$%^&*()')).toBeNull();
  });

  it('drops noise single characters but keeps a lone one-character search', () => {
    expect(toTsQuery('a invoice')).toBe('invoice:*');
    expect(toTsQuery('x')).toBe('x:*');
  });

  it('is case-insensitive', () => {
    expect(toTsQuery('WhatsApp')).toBe('whatsapp:*');
  });
});

describe('parseCaseStudySections', () => {
  const body = [
    'PROBLEM',
    '',
    'Claims take weeks.',
    '',
    'WHAT GETS BUILT',
    '',
    'An n8n automation that triages claims.',
    '',
    'CONNECTS TO',
    '',
    'Web form as intake channel',
    'Claude API for extraction',
    '',
    'DEFINITION OF DONE',
    '',
    'All claims acknowledged in 5 minutes.',
  ].join('\n');

  it('splits the four canonical sections', () => {
    const s = parseCaseStudySections(body);
    expect(s.problem).toBe('Claims take weeks.');
    expect(s.whatGetsBuilt).toBe('An n8n automation that triages claims.');
    expect(s.definitionOfDone).toBe('All claims acknowledged in 5 minutes.');
  });

  it('turns CONNECTS TO into a list rather than prose', () => {
    expect(parseCaseStudySections(body).connectsTo).toEqual([
      'Web form as intake channel',
      'Claude API for extraction',
    ]);
  });

  it('strips bullet markers from the connects-to list', () => {
    const s = parseCaseStudySections('CONNECTS TO\n\n- Zoom API\n• Buffer\n* ClickUp');
    expect(s.connectsTo).toEqual(['Zoom API', 'Buffer', 'ClickUp']);
  });

  it('returns nulls for an unparseable body so the caller can fall back to body_md', () => {
    const s = parseCaseStudySections('Just a paragraph with no headings at all.');
    expect(s).toEqual({
      problem: null,
      whatGetsBuilt: null,
      connectsTo: null,
      definitionOfDone: null,
    });
  });

  it('ignores heading words that appear mid-sentence', () => {
    // "problem" here is prose, not a heading — only a line of its own counts.
    const s = parseCaseStudySections('PROBLEM\n\nThe real PROBLEM is scale, and WHAT GETS BUILT matters.');
    expect(s.problem).toBe('The real PROBLEM is scale, and WHAT GETS BUILT matters.');
    expect(s.whatGetsBuilt).toBeNull();
  });

  it('handles empty and CRLF input', () => {
    expect(parseCaseStudySections('').problem).toBeNull();
    expect(parseCaseStudySections('PROBLEM\r\n\r\nSlow.').problem).toBe('Slow.');
  });
});
