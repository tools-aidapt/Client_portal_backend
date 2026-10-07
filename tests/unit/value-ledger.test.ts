import { describe, expect, it } from 'vitest';
import {
  LINK_TTL_SECONDS,
  buildLedgerLink,
  signEmbed,
} from '@modules/value-ledger/value-ledger.service.js';

const SECRET = 'test-embed-secret-0123456789';
// 2026-01-01T00:00:00Z
const NOW_MS = 1_767_225_600_000;
const EXP = 1_767_225_600 + LINK_TTL_SECONDS;
// Independently computed: HMAC-SHA256('abl.1767225900', SECRET), hex.
const KNOWN_SIG = 'c00ed2a641592fa63f0190b60fa52c6504bccc87f1dcc017f479b798ecc1ff7c';

const cfg = {
  url: 'https://ledger.example.com/',
  embedSecret: SECRET,
  clientMap: { 'allied-bank': 'abl', kenafric: 'kenafric' },
};

describe('signEmbed', () => {
  it('matches the known HMAC-SHA256 vector over `${clientKey}.${exp}`', () => {
    expect(signEmbed('abl', EXP, SECRET)).toBe(KNOWN_SIG);
  });
});

describe('buildLedgerLink', () => {
  it('builds a signed embed URL that expires five minutes from now', () => {
    expect(buildLedgerLink('allied-bank', cfg, NOW_MS)).toEqual({
      configured: true,
      url: `https://ledger.example.com/embed/abl?exp=${EXP}&sig=${KNOWN_SIG}`,
      expiresAt: '2026-01-01T00:05:00.000Z',
    });
  });

  it('returns configured:false for a tenant with no mapping', () => {
    expect(buildLedgerLink('tile-carpet-centre', cfg, NOW_MS)).toEqual({ configured: false });
  });

  it('never resolves inherited object keys as a mapping', () => {
    expect(buildLedgerLink('constructor', cfg, NOW_MS)).toEqual({ configured: false });
  });

  it('returns configured:false when any piece of config is missing', () => {
    expect(buildLedgerLink('allied-bank', { ...cfg, url: undefined }, NOW_MS)).toEqual({ configured: false });
    expect(buildLedgerLink('allied-bank', { ...cfg, embedSecret: undefined }, NOW_MS)).toEqual({
      configured: false,
    });
    expect(buildLedgerLink('allied-bank', { ...cfg, clientMap: undefined }, NOW_MS)).toEqual({
      configured: false,
    });
    expect(buildLedgerLink(null, cfg, NOW_MS)).toEqual({ configured: false });
  });
});
