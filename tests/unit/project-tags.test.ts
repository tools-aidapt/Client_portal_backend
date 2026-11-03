import { describe, expect, it } from 'vitest';
import { accentTone, slugifyTagKey, tagSelectionError } from '@modules/portal/project-tags.js';
import { createTagBody, setProjectTagsBody } from '@modules/admin/clients/validators/project-tags.validators.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('slugifyTagKey', () => {
  it.each([
    ['Go-live', 'go-live'],
    ['Phase 2', 'phase-2'],
    ['  Awaiting   client! ', 'awaiting-client'],
    ['Caf\u00e9', 'cafe'],
    ['!!!', ''],
  ])('%s -> %s', (label, key) => expect(slugifyTagKey(label)).toBe(key));
});

describe('tagSelectionError', () => {
  it('accepts a primary inside the set, or none', () => {
    expect(tagSelectionError([id(1), id(2)], id(2))).toBeNull();
    expect(tagSelectionError([id(1)], null)).toBeNull();
    expect(tagSelectionError([], null)).toBeNull();
  });
  it('rejects a primary outside the set and duplicates', () => {
    expect(tagSelectionError([id(1)], id(2))).toMatch(/primary_tag_id/);
    expect(tagSelectionError([], id(1))).toMatch(/primary_tag_id/);
    expect(tagSelectionError([id(1), id(1)], null)).toMatch(/duplicates/);
  });
});

describe('setProjectTagsBody', () => {
  it('accepts a valid replacement, including clearing', () => {
    expect(setProjectTagsBody.safeParse({ tag_ids: [id(1), id(2)], primary_tag_id: id(1) }).success).toBe(true);
    expect(setProjectTagsBody.safeParse({ tag_ids: [], primary_tag_id: null }).success).toBe(true);
  });
  it('rejects more than 8 tags, non-uuids, and a primary outside the set', () => {
    const nine = Array.from({ length: 9 }, (_, i) => id(i + 1));
    expect(setProjectTagsBody.safeParse({ tag_ids: nine, primary_tag_id: null }).success).toBe(false);
    expect(setProjectTagsBody.safeParse({ tag_ids: ['nope'], primary_tag_id: null }).success).toBe(false);
    expect(setProjectTagsBody.safeParse({ tag_ids: [id(1)], primary_tag_id: id(2) }).success).toBe(false);
    expect(setProjectTagsBody.safeParse({ tag_ids: [id(1)] }).success).toBe(false);
  });
});

describe('createTagBody', () => {
  it('validates label length and tone', () => {
    expect(createTagBody.safeParse({ label: 'Go-live', tone: 'success' }).success).toBe(true);
    expect(createTagBody.safeParse({ label: '', tone: 'success' }).success).toBe(false);
    expect(createTagBody.safeParse({ label: 'x'.repeat(41), tone: 'success' }).success).toBe(false);
    expect(createTagBody.safeParse({ label: 'Ok', tone: 'purple' }).success).toBe(false);
    expect(createTagBody.safeParse({ label: '***', tone: 'info' }).success).toBe(false);
  });
});

describe('accentTone', () => {
  const tag = (tone: string, is_primary: boolean) => ({ id: 'a', key: 'k', label: 'L', tone, is_primary });
  it('prefers the primary tag, else the status tone, else null', () => {
    expect(accentTone([tag('error', true), tag('info', false)], 'success')).toBe('error');
    expect(accentTone([tag('info', false)], 'success')).toBe('success');
    expect(accentTone([], null)).toBeNull();
  });
});
