import { test, expect, type APIRequestContext } from '@playwright/test';

async function getResponseBody(request: APIRequestContext, path: string): Promise<string> {
  const response = await request.get(path);
  expect(response.ok()).toBeTruthy();
  return response.text();
}

function expectNoindexNofollow(html: string): void {
  expect(html).toMatch(/<meta[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex[^"']*nofollow[^"']*["'][^>]*>/i);
}

test.describe('SEO metadata and crawler policy', () => {
  test('robots.txt blocks private routes and points to sitemap', async ({ request }) => {
    const text = await getResponseBody(request, '/robots.txt');

    expect(text).toContain('User-agent: *');
    expect(text).toContain('Disallow: /home');
    expect(text).toContain('Disallow: /children');
    expect(text).toContain('Disallow: /inbox');
    expect(text).toContain('Disallow: /more');
    expect(text).toContain('Disallow: /auth/syncing');
    expect(text).toContain('Allow: /auth/sign-in');
    expect(text).toContain('Allow: /');
    expect(text).toContain('Sitemap: https://mashov.mitya.dev/sitemap.xml');
  });

  test('sitemap.xml includes only the public sign-in URL', async ({ request }) => {
    const xml = await getResponseBody(request, '/sitemap.xml');

    expect(xml).toContain('<loc>https://mashov.mitya.dev/auth/sign-in</loc>');
    expect(xml).not.toContain('/home</loc>');
    expect(xml).not.toContain('/children</loc>');
    expect(xml).not.toContain('/inbox</loc>');
    expect(xml).not.toContain('/more</loc>');
  });

  test('sign-in page exposes canonical, description, and social tags', async ({ request }) => {
    const html = await getResponseBody(request, '/auth/sign-in');

    expect(html).toContain('<title>כניסה למרכז הורים | מרכז הורים</title>');
    expect(html).toContain('name="description" content="התחברו למרכז הורים — צפו בציונים, שיעורי בית והודעות של ילדכם דרך מערכת משוב"');
    expect(html).toContain('rel="canonical" href="https://mashov.mitya.dev/auth/sign-in"');
    expect(html).toContain('property="og:title" content="כניסה | מרכז הורים"');
    expect(html).toContain('property="og:description" content="התחברו למרכז הורים — צפו בציונים, שיעורי בית והודעות של ילדכם דרך מערכת משוב"');
    expect(html).toContain('name="twitter:card" content="summary"');
    expect(html).toContain('name="twitter:title" content="מרכז הורים"');
  });

  test('all private routes emit noindex,nofollow', async ({ request }) => {
    const privateRoutes = [
      '/home',
      '/children',
      '/inbox',
      '/more',
      '/auth/syncing',
      '/children/student-guid-1',
      '/children/student-guid-1/homework/homework-1',
      '/children/student-guid-1/behavior/behavior-1',
      '/inbox/conversation-1',
    ];

    for (const path of privateRoutes) {
      const html = await getResponseBody(request, path);
      expectNoindexNofollow(html);
    }
  });
});
