import { createApp } from './loaders/express.js';

/**
 * The configured Express application instance.
 * Import this in tests; `server.ts` binds it to a port.
 */
export const app = createApp();
