import { createHmac } from 'node:crypto';
import { config } from '@config/index.js';
import { valueLedgerRepo } from './value-ledger.repository.js';

/** How long a signed embed link stays valid. The ledger checks `exp` itself. */
export const LINK_TTL_SECONDS = 300;

export interface ValueLedgerConfig {
  url?: string;
  embedSecret?: string;
  clientMap?: Record<string, string>;
}

export type ValueLedgerLink =
  | { configured: false }
  | { configured: true; url: string; expiresAt: string };

/** Hex HMAC-SHA256 over `${clientKey}.${exp}`, the format the ledger verifies. */
export function signEmbed(clientKey: string, exp: number, secret: string): string {
  return createHmac('sha256', secret).update(`${clientKey}.${exp}`).digest('hex');
}

/**
 * Builds the signed embed link for a tenant slug. Pure (config and clock are
 * passed in) so it is unit-testable without a database or env.
 *
 * The client key comes only from the server-side map, looked up by the slug of
 * the tenant `requireTenantRole` resolved. Nothing the browser sends can pick
 * another client's ledger.
 */
export function buildLedgerLink(
  slug: string | null,
  cfg: ValueLedgerConfig,
  nowMs: number = Date.now(),
): ValueLedgerLink {
  if (!slug || !cfg.url || !cfg.embedSecret || !cfg.clientMap) return { configured: false };
  const clientKey = Object.hasOwn(cfg.clientMap, slug) ? cfg.clientMap[slug] : undefined;
  if (!clientKey) return { configured: false };

  const exp = Math.floor(nowMs / 1000) + LINK_TTL_SECONDS;
  const sig = signEmbed(clientKey, exp, cfg.embedSecret);
  const base = cfg.url.replace(/\/+$/, '');
  return {
    configured: true,
    url: `${base}/embed/${encodeURIComponent(clientKey)}?exp=${exp}&sig=${sig}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export const valueLedgerService = {
  async link(tenantId: string): Promise<ValueLedgerLink> {
    const cfg = config.valueLedger;
    // Skip the lookup entirely when nothing is configured yet.
    if (!cfg.url || !cfg.embedSecret || !cfg.clientMap) return { configured: false };
    return buildLedgerLink(await valueLedgerRepo.tenantSlug(tenantId), cfg);
  },
};
