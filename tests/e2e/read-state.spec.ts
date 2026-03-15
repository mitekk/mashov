import { test, expect, request as playwrightRequest } from '@playwright/test';

const BACKEND_URL = process.env.PLAYWRIGHT_BACKEND_URL ?? 'http://localhost:3001';

/**
 * E2E tests verifying that the ReadState API has been removed.
 *
 * POST /api/v1/read-state and DELETE /api/v1/read-state must return 404
 * since ReadState was replaced by isNew/isArchived fields on the source models.
 */
test.describe('Read-state API: removed endpoints return 404', () => {
  test('POST /api/v1/read-state returns 404', async () => {
    const apiContext = await playwrightRequest.newContext({
      baseURL: BACKEND_URL,
    });

    const res = await apiContext.post('/api/v1/read-state', {
      data: { itemType: 'homework', itemId: 'hw-1', isHandled: true },
    });

    expect(res.status()).toBe(404);

    await apiContext.dispose();
  });

  test('DELETE /api/v1/read-state returns 404', async () => {
    const apiContext = await playwrightRequest.newContext({
      baseURL: BACKEND_URL,
    });

    const res = await apiContext.delete('/api/v1/read-state');

    expect(res.status()).toBe(404);

    await apiContext.dispose();
  });
});
