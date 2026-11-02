import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

const query = vi.fn();
vi.mock('@infra/db/pool.js', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

const { requireAidaptStaff } = await import('@/api/middlewares/authorize.js');

/** Run the middleware and return what it passed to `next` (undefined = allowed). */
async function run(auth: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const next: NextFunction = (err?: unknown) => resolve(err);
    void requireAidaptStaff({ auth } as unknown as Request, {} as Response, next);
  });
}

const user = { user: { id: 'u1' } };

describe('requireAidaptStaff', () => {
  beforeEach(() => query.mockReset());

  it('allows a platform admin on an aidapt.co login', async () => {
    query.mockResolvedValue({ rows: [{ is_platform_admin: true, email: 'Someone@Aidapt.co ' }] });
    expect(await run(user)).toBeUndefined();
  });

  it('rejects a platform admin whose login is not aidapt.co', async () => {
    query.mockResolvedValue({ rows: [{ is_platform_admin: true, email: 'admin@kenafric.com' }] });
    expect(await run(user)).toMatchObject({ statusCode: 403 });
  });

  it('rejects an aidapt.co login that is not a platform admin', async () => {
    query.mockResolvedValue({ rows: [{ is_platform_admin: false, email: 'intern@aidapt.co' }] });
    expect(await run(user)).toMatchObject({ statusCode: 403 });
  });

  it('rejects a look-alike domain', async () => {
    query.mockResolvedValue({ rows: [{ is_platform_admin: true, email: 'x@notaidapt.co.evil.com' }] });
    expect(await run(user)).toMatchObject({ statusCode: 403 });
  });

  it('rejects an account with no credentials row', async () => {
    query.mockResolvedValue({ rows: [{ is_platform_admin: true, email: null }] });
    expect(await run(user)).toMatchObject({ statusCode: 403 });
  });

  it('rejects an unauthenticated request without touching the database', async () => {
    expect(await run(undefined)).toMatchObject({ statusCode: 401 });
    expect(query).not.toHaveBeenCalled();
  });
});
