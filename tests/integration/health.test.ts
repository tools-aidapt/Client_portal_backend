import { describe, expect, it } from 'vitest';
import { createApp } from '@/loaders/express.js';

// Minimal smoke test. For full HTTP assertions add `supertest`.
describe('app bootstrap', () => {
  it('builds the Express app without throwing', () => {
    const app = createApp();
    expect(app).toBeTypeOf('function');
  });
});
