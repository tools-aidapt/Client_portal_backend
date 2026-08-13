import { Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { asyncHandler } from '@common/utils/async-handler.js';
import { ok } from '@common/utils/api-response.js';
import { AppError } from '@common/errors/index.js';
import { authenticate } from '@/api/middlewares/authenticate.js';
import { requirePlatformAdmin } from '@/api/middlewares/authorize.js';
import { logger } from '@infra/logger/index.js';
import { syncConsoleService, SYNC_ENTITIES } from './sync-console.service.js';

/**
 * Browser-facing sync control for platform admins (the Sync Console).
 *
 * Deliberately separate from `/internal/sync/*`, which is service-secret and
 * machine-facing. Same underlying services, different door: a browser must
 * never be handed `INTERNAL_API_SECRET`, and n8n must not depend on a user
 * session. Same `authenticate + requirePlatformAdmin` pairing as
 * `adminWishlistRoutes`.
 *
 * NOT exposed to clients, and the reason is stronger than rate limiting:
 * `spaces`, `sprint`, `wishlist`, `onboarding`, `reports` and `use_cases` are
 * all CROSS-TENANT walks that route by Client Group. A per-client "sync my
 * data" button would silently rewrite every other client's cache, and would
 * spend the single shared `CLICKUP_API_TOKEN` that all syncing depends on.
 */
export const syncConsoleRoutes = Router();

syncConsoleRoutes.use(authenticate, requirePlatformAdmin);

syncConsoleRoutes.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    res.status(StatusCodes.OK).json(ok(await syncConsoleService.overview()));
  }),
);

/**
 * Run one entity, streaming progress as SSE.
 *
 * POST, not GET, because it mutates — which also rules out `EventSource`, that
 * being GET-only AND unable to send an `Authorization` header. The client
 * therefore reads this with `fetch` + a `ReadableStream` reader and parses the
 * frames itself. Putting the bearer token in a query string to satisfy
 * `EventSource` was the alternative and was rejected: it would copy an access
 * token into every proxy and access log between here and the browser.
 *
 * A heartbeat comment goes out every 15s. Render (and most proxies) close an
 * idle connection well before the ~2 minutes a Use Cases walk takes, and the
 * gaps between real events during a long ClickUp page fetch are easily that
 * wide.
 */
syncConsoleRoutes.post(
  '/run/:entity',
  asyncHandler(async (req, res) => {
    const { entity } = req.params;
    const userId = req.auth?.user.id;
    if (!userId) throw new AppError('No authenticated user', 401, 'UNAUTHENTICATED');

    res.status(StatusCodes.OK);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Nginx/Render buffer proxied responses by default, which defeats streaming
    // entirely — the browser would receive the whole log at the end.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (payload: unknown) => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': keep-alive\n\n');
    }, 15_000);

    // If the admin closes the tab the sync keeps going on purpose: it is
    // mid-write against task_cache, and abandoning it half-done would leave a
    // partially-refreshed cache with no record of why.
    let clientGone = false;
    req.on('close', () => {
      clientGone = true;
      logger.info({ entity }, 'Sync console client disconnected — run continues');
    });

    try {
      const result = await syncConsoleService.runEntity(entity!, userId, (e) => {
        if (!clientGone) send(e);
      });
      send({ phase: 'result', message: 'Run complete', result });
    } catch (err) {
      const status = err instanceof AppError ? err.statusCode : 500;
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, entity }, 'Sync console run failed');
      send({ phase: 'error', message, status });
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  }),
);

/** The entity catalogue, so the UI never hardcodes the list. */
syncConsoleRoutes.get(
  '/entities',
  asyncHandler(async (_req, res) => {
    res.status(StatusCodes.OK).json(
      ok(SYNC_ENTITIES.map(({ key, label, description, scale }) => ({ key, label, description, scale }))),
    );
  }),
);
