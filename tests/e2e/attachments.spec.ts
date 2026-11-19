import * as fs from 'fs';
import * as path from 'path';
import { test, expect, type Page, type Route } from '@playwright/test';
import { AttachmentViewerPage } from './pages/AttachmentViewerPage';

/**
 * E2E tests for the in-app attachment viewer.
 *
 * The binary endpoints are `route.fulfill`ed with real bytes so the viewer's
 * MIME resolution runs for real: a PNG, a minimal PDF, the same PDF served as
 * `application/octet-stream` (the extension-fallback path, which is the one
 * most likely to regress), a real `.docx` from `fixtures/`, a file named
 * `.docx` whose bytes are not a zip, an `.xlsx` standing in for the types
 * that still cannot preview, a 404 and a 504 envelope.
 */

const STUDENT_GUID = 'e2e-test-student-guid-00002';
const HOMEWORK_ID = 'hw-files';
const BEHAVIOR_ID = 'beh-files';
const CONVERSATION_ID = 'conv-files';
const MESSAGE_ID = 'msg-files';

/** 1×1 transparent PNG. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

/** A minimal single-page PDF. Only needs to be recognizably a PDF — the test
 * asserts the iframe is rendered, not what the browser's viewer draws. */
const MINIMAL_PDF = [
  '%PDF-1.4',
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj',
  'trailer<</Root 1 0 R/Size 4>>',
  '%%EOF',
].join('\n');

/** A real Word file: RTL heading, Hebrew paragraph, bordered table. See
 * `fixtures/README.md`. */
const SAMPLE_DOCX = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.docx'));

/** Text the fixture carries, used to prove the parse actually happened rather
 * than just the container mounting. */
const DOCX_HEADING = 'אישור הורים לטיול השנתי';

const DOCX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const FILES = [
  { fileId: 'file-png', fileName: 'photo.png' },
  { fileId: 'file-pdf', fileName: 'letter.pdf' },
  { fileId: 'file-octet-pdf', fileName: 'mystery.pdf' },
  // The stand-in for "a type that can never preview". It used to be the
  // `.docx`, which now renders.
  { fileId: 'file-xlsx', fileName: 'grades.xlsx' },
  { fileId: 'file-missing', fileName: 'gone.pdf' },
  { fileId: 'file-timeout', fileName: 'slow.pdf' },
  { fileId: 'file-docx', fileName: 'form.docx' },
  { fileId: 'file-docx-corrupt', fileName: 'broken.docx' },
];

const XLSX_FILE = FILES[3];
const DOCX_FILE = FILES[6];
const CORRUPT_DOCX_FILE = FILES[7];

const MOCK_ME = {
  mashovUserId: 'e2e-parent-1',
  username: 'e2e-parent',
  displayName: 'E2E Parent',
  connectedSchool: { schoolName: 'Test School', schoolYear: 2026 },
};

/** Serve one attachment according to its file id. */
async function fulfillAttachment(route: Route): Promise<void> {
  const fileId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() ?? '');

  switch (fileId) {
    case 'file-png':
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        headers: { 'content-disposition': 'attachment; filename="photo.png"' },
        body: Buffer.from(PNG_BASE64, 'base64'),
      });
      return;

    case 'file-pdf':
      await route.fulfill({
        status: 200,
        contentType: 'application/pdf',
        headers: { 'content-disposition': 'attachment; filename="letter.pdf"' },
        body: Buffer.from(MINIMAL_PDF, 'utf-8'),
      });
      return;

    // No upstream content type: the viewer must fall back to the extension.
    case 'file-octet-pdf':
      await route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        headers: { 'content-disposition': 'attachment; filename="mystery.pdf"' },
        body: Buffer.from(MINIMAL_PDF, 'utf-8'),
      });
      return;

    case 'file-xlsx':
      await route.fulfill({
        status: 200,
        contentType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        headers: { 'content-disposition': 'attachment; filename="grades.xlsx"' },
        body: Buffer.from('PK\u0003\u0004 not really an xlsx', 'utf-8'),
      });
      return;

    case 'file-docx':
      await route.fulfill({
        status: 200,
        contentType: DOCX_CONTENT_TYPE,
        headers: { 'content-disposition': 'attachment; filename="form.docx"' },
        body: SAMPLE_DOCX,
      });
      return;

    // Named `.docx`, but the bytes are not a zip — a mislabeled or truncated
    // file, which is what the parse has to fail gracefully on.
    case 'file-docx-corrupt':
      await route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        headers: { 'content-disposition': 'attachment; filename="broken.docx"' },
        body: Buffer.from('PK\u0003\u0004 not really a docx', 'utf-8'),
      });
      return;

    case 'file-missing':
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'NOT_FOUND', message: 'File not found', details: [] },
        }),
      });
      return;

    case 'file-timeout':
      await route.fulfill({
        status: 504,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'GATEWAY_TIMEOUT',
            message: 'The server took too long to respond.',
            details: [],
          },
        }),
      });
      return;

    default:
      await route.fulfill({ status: 404, body: '' });
  }
}

function makeHomeworkDetail(files: Array<{ fileId: string; fileName: string }>) {
  return {
    id: HOMEWORK_ID,
    studentGuid: STUDENT_GUID,
    lessonId: 1,
    groupId: 1,
    lessonDate: new Date().toISOString(),
    lesson: 2,
    subjectName: 'Math',
    homeworkText: 'Sign the attached form',
    remark: null,
    files,
    isNew: true,
    isArchived: false,
    updatedAt: new Date().toISOString(),
  };
}

function makeBehaviorDetail(files: Array<{ fileId: string; fileName: string }>) {
  return {
    id: BEHAVIOR_ID,
    studentGuid: STUDENT_GUID,
    lessonId: 1,
    groupId: 1,
    eventCode: 2,
    achvaCode: 2,
    achvaName: 'Absence',
    bucket: 'attention',
    priority: 'high',
    justifiable: false,
    lessonDate: new Date().toISOString(),
    lesson: 2,
    subject: 'Math',
    reporter: 'Teacher',
    remark: null,
    justification: null,
    files,
    eventAt: new Date().toISOString(),
    isNew: true,
    isArchived: false,
    updatedAt: new Date().toISOString(),
  };
}

function makeConversationDetail(files: Array<{ fileId: string; fileName: string }>) {
  return {
    conversationId: CONVERSATION_ID,
    subject: 'With attachments',
    sendTime: new Date().toISOString(),
    isNew: true,
    hasDrafts: false,
    hasAttachments: true,
    preventReply: false,
    labels: [],
    lastFetchedAt: new Date().toISOString(),
    messages: [
      {
        messageId: MESSAGE_ID,
        conversationId: CONVERSATION_ID,
        senderId: 'sender-1',
        senderName: 'Teacher',
        subject: 'With attachments',
        bodyHtmlSanitized: '<p>Please sign</p>',
        bodyTextPreview: 'Please sign',
        sendTime: new Date().toISOString(),
        isNew: true,
        recipients: [],
        files,
        hasAttachments: true,
        preventReply: false,
        sentViaEmail: false,
        sentViaSms: false,
      },
    ],
  };
}

async function json(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/** Stub the shell routes every page in the app loads. */
async function stubShell(page: Page): Promise<void> {
  // `window.print()` would open a native dialog and block the runner. The
  // frame is appended before `print()` is called, so the print assertions do
  // not depend on this — it only keeps the page responsive afterwards.
  await page.addInitScript(() => {
    window.print = () => {};
  });

  await page.route('**/api/v1/auth/me', (route) => json(route, MOCK_ME));
  await page.route('**/api/v1/dashboard', (route) =>
    json(route, {
      freshness: { state: 'fresh', lastSyncAt: null, staleSources: [] },
      summary: {
        newConversations: 0,
        recentHomeworkCount: 0,
        recentBehaviorCount: 0,
        childrenCount: 0,
      },
      feed: [],
      children: [],
      school: { schoolName: 'Test School', schoolYear: 2026 },
    }),
  );
  await page.route('**/api/v1/children', (route) => json(route, { data: [] }));
  await page.route('**/api/v1/mail/summary', (route) =>
    json(route, { newConversations: 0, recentConversations: [], lastSyncAt: null }),
  );
  // Catch-all first: the conversation detail page auto-fires a mark-read
  // mutation, and an unstubbed call reaches the real backend, 401s and bounces
  // the browser to the sign-in page. Later, more specific routes win.
  await page.route('**/api/v1/mail/conversations**', (route) =>
    json(route, { data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } }),
  );
  await page.route('**/api/v1/children/*/homework/*/is-new', (route) => json(route, { ok: true }));
  await page.route('**/api/v1/children/*/homework/*/archive', (route) => json(route, { ok: true }));
  await page.route('**/api/v1/children/*/behavior/*/is-new', (route) => json(route, { ok: true }));
  await page.route('**/api/v1/children/*/behavior/*/archive', (route) => json(route, { ok: true }));
  await page.route('**/api/v1/mail/conversations/*/is-new', (route) => json(route, { ok: true }));
}

/** Open the homework detail page carrying `files`. */
async function gotoHomework(
  page: Page,
  files: Array<{ fileId: string; fileName: string }>,
): Promise<void> {
  await stubShell(page);
  await page.route(`**/api/v1/children/${STUDENT_GUID}/homework/${HOMEWORK_ID}/files/*`, fulfillAttachment);
  await page.route(`**/api/v1/children/${STUDENT_GUID}/homework/${HOMEWORK_ID}`, (route) =>
    json(route, makeHomeworkDetail(files)),
  );

  await page.goto(`/children/${STUDENT_GUID}/homework/${HOMEWORK_ID}`);
  await expect(page.getByTestId(`homework-detail-${HOMEWORK_ID}`)).toBeVisible();
}

test.describe('Attachment viewer', () => {
  test('opens the viewer in place instead of downloading, and shows the file name', async ({
    page,
  }) => {
    await gotoHomework(page, [FILES[0]]);
    const viewer = new AttachmentViewerPage(page);

    await expect(viewer.list).toBeVisible();
    await viewer.open('file-png');

    await expect(viewer.title).toHaveText('photo.png');
    await expect(viewer.imagePreview).toBeVisible();
    // A single file carries no counter and no navigation.
    await expect(viewer.counter).toBeHidden();
    await expect(viewer.nextButton).toBeHidden();

    await viewer.close();
    await expect(viewer.list).toBeVisible();
  });

  test('attachment rows stay real links so the href keeps guarding URL construction', async ({
    page,
  }) => {
    await gotoHomework(page, [FILES[0]]);
    const viewer = new AttachmentViewerPage(page);

    await expect(viewer.item('file-png')).toHaveAttribute(
      'href',
      `/api/v1/children/${STUDENT_GUID}/homework/${HOMEWORK_ID}/files/file-png`,
    );
    await expect(viewer.item('file-png')).toHaveAttribute('download', 'photo.png');
  });

  test('renders a PDF inline', async ({ page }) => {
    await gotoHomework(page, [FILES[1]]);
    const viewer = new AttachmentViewerPage(page);

    await viewer.open('file-pdf');

    await expect(viewer.pdfPreview).toBeVisible();
    await expect(viewer.pdfPreview).toHaveAttribute('title', 'letter.pdf');
  });

  test('previews an octet-stream response by falling back to the .pdf filename', async ({
    page,
  }) => {
    await gotoHomework(page, [FILES[2]]);
    const viewer = new AttachmentViewerPage(page);

    await viewer.open('file-octet-pdf');

    await expect(viewer.pdfPreview).toBeVisible();
    await expect(viewer.unsupportedCard).toBeHidden();

    // Rendering the iframe is not enough: a blob URL still typed
    // `application/octet-stream` makes the browser decline to open its PDF
    // viewer, so the frame would come up blank. The blob must carry the
    // *resolved* type, and a blob: URL is fetchable from the page to prove it.
    const blobType = await page.evaluate(async () => {
      const frame = document.querySelector<HTMLIFrameElement>(
        '[data-testid="attachment-preview-pdf"]',
      );
      if (!frame) return 'no-frame';
      const response = await fetch(frame.src);
      return (await response.blob()).type;
    });
    expect(blobType).toBe('application/pdf');
  });

  test('offers download but not print for a file it cannot preview', async ({ page }) => {
    await gotoHomework(page, [XLSX_FILE]);
    const viewer = new AttachmentViewerPage(page);

    await viewer.open('file-xlsx');

    await expect(viewer.unsupportedCard).toBeVisible();
    await expect(viewer.unsupportedDownloadButton).toBeVisible();
    await expect(viewer.printButton).toBeHidden();
    await expect(viewer.downloadButton).toBeEnabled();
  });

  test('does not download a file whose extension already rules out a preview', async ({
    page,
  }) => {
    const requested: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes(`/homework/${HOMEWORK_ID}/files/`)) {
        requested.push(request.url());
      }
    });

    await gotoHomework(page, [XLSX_FILE]);
    const viewer = new AttachmentViewerPage(page);

    await viewer.open('file-xlsx');
    await expect(viewer.unsupportedCard).toBeVisible();

    // An `.xlsx` can never render inline, and no response header could change
    // that — so pulling it into memory just to say so would cost a parent on
    // mobile data the whole transfer. (A `.docx` is the opposite case now; see
    // the docx test below, which asserts the request *is* made.)
    expect(requested).toEqual([]);

    // Download still works: it navigates to the endpoint, whose
    // Content-Disposition makes the browser save it.
    const downloadPromise = page.waitForEvent('download');
    await viewer.unsupportedDownloadButton.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('grades.xlsx');
  });

  test('renders a real .docx inline, parsed from its own bytes', async ({ page }) => {
    const requested: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes(`/homework/${HOMEWORK_ID}/files/`)) {
        requested.push(request.url());
      }
    });

    await gotoHomework(page, [DOCX_FILE]);
    const viewer = new AttachmentViewerPage(page);

    await viewer.open('file-docx');

    await expect(viewer.docxPreview).toBeVisible();
    await expect(viewer.unsupportedCard).toBeHidden();

    // The container alone proves nothing — the parse is what is under test, so
    // assert the document's own text. It lives in an open shadow root, which
    // Playwright's text engine pierces.
    await expect(viewer.docxPreview).toContainText(DOCX_HEADING);
    await expect(viewer.docxPreview).toContainText('ירושלים');

    // The inverse of the skip-the-fetch rule: a `.docx` is worth the transfer
    // now, because the bytes are what gets rendered.
    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain('file-docx');
  });

  test('shows the error state with a download escape hatch when the .docx is not a zip', async ({
    page,
  }) => {
    await gotoHomework(page, [CORRUPT_DOCX_FILE]);
    const viewer = new AttachmentViewerPage(page);

    await viewer.open('file-docx-corrupt');

    await expect(viewer.error).toBeVisible();
    await expect(viewer.error).toContainText('לא ניתן להציג את הקובץ');
    await expect(viewer.errorFallbackLink).toHaveAttribute(
      'href',
      `/api/v1/children/${STUDENT_GUID}/homework/${HOMEWORK_ID}/files/file-docx-corrupt`,
    );
    await expect(viewer.errorFallbackLink).toHaveAttribute('download', 'broken.docx');

    // Nothing to print: the render never completed.
    await expect(viewer.printButton).toBeHidden();
  });

  test('prints a .docx as the rendered document, not as its zip bytes', async ({ page }) => {
    await gotoHomework(page, [DOCX_FILE]);
    const viewer = new AttachmentViewerPage(page);

    await viewer.open('file-docx');
    await expect(viewer.docxPreview).toContainText(DOCX_HEADING);

    // The button only appears once the parse has produced a render — before
    // that there is nothing to print.
    await expect(viewer.printButton).toBeVisible();
    await viewer.printButton.click();

    await expect(viewer.printFrame).toBeAttached();

    // What separates a correct docx printout from the old failure mode (the
    // raw zip escaped into a `<pre>`): the frame's document carries the
    // document's text.
    const frame = page.frameLocator('[data-testid="attachment-print-frame"]');
    await expect(frame.locator('body')).toContainText(DOCX_HEADING);
  });

  test('navigates between several files with the buttons and the counter tracks', async ({
    page,
  }) => {
    await gotoHomework(page, [FILES[0], FILES[1], XLSX_FILE]);
    const viewer = new AttachmentViewerPage(page);

    await viewer.open('file-png');

    await expect(viewer.counter).toHaveText('1 / 3');
    await expect(viewer.previousButton).toBeDisabled();

    await viewer.nextButton.click();
    await expect(viewer.counter).toHaveText('2 / 3');
    await expect(viewer.title).toHaveText('letter.pdf');
    await expect(viewer.pdfPreview).toBeVisible();

    await viewer.nextButton.click();
    await expect(viewer.counter).toHaveText('3 / 3');
    await expect(viewer.title).toHaveText('grades.xlsx');
    await expect(viewer.nextButton).toBeDisabled();

    await viewer.previousButton.click();
    await expect(viewer.counter).toHaveText('2 / 3');
  });

  test('ArrowLeft advances and ArrowRight goes back, as RTL requires', async ({ page }) => {
    await gotoHomework(page, [FILES[0], XLSX_FILE]);
    const viewer = new AttachmentViewerPage(page);

    await viewer.open('file-png');
    await expect(viewer.counter).toHaveText('1 / 2');

    await viewer.pressAdvanceKey();
    await expect(viewer.counter).toHaveText('2 / 2');
    await expect(viewer.title).toHaveText('grades.xlsx');

    await viewer.pressBackKey();
    await expect(viewer.counter).toHaveText('1 / 2');
    await expect(viewer.title).toHaveText('photo.png');
  });

  test('shows a retryable error and a direct-download escape hatch when the file is gone', async ({
    page,
  }) => {
    await gotoHomework(page, [FILES[4]]);
    const viewer = new AttachmentViewerPage(page);

    await viewer.open('file-missing');

    await expect(viewer.error).toBeVisible();
    await expect(viewer.error).toContainText('הקובץ אינו זמין יותר במשוב');
    await expect(page.getByTestId('error-retry-button')).toBeVisible();

    await expect(viewer.errorFallbackLink).toBeVisible();
    await expect(viewer.errorFallbackLink).toHaveAttribute(
      'href',
      `/api/v1/children/${STUDENT_GUID}/homework/${HOMEWORK_ID}/files/file-missing`,
    );
    await expect(viewer.errorFallbackLink).toHaveAttribute('download', 'gone.pdf');
  });

  test('shows the timeout message for a 504 envelope', async ({ page }) => {
    await gotoHomework(page, [FILES[5]]);
    const viewer = new AttachmentViewerPage(page);

    await viewer.open('file-timeout');

    await expect(viewer.error).toBeVisible();
    await expect(viewer.error).toContainText('הקובץ לא נטען בזמן');
  });

  test('downloads the file from inside the viewer', async ({ page }) => {
    await gotoHomework(page, [FILES[0]]);
    const viewer = new AttachmentViewerPage(page);

    await viewer.open('file-png');
    await expect(viewer.imagePreview).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await viewer.downloadButton.click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe('photo.png');
  });

  test('mounts a print frame when printing', async ({ page }) => {
    await gotoHomework(page, [FILES[0]]);
    const viewer = new AttachmentViewerPage(page);

    await viewer.open('file-png');
    await expect(viewer.imagePreview).toBeVisible();

    await viewer.printButton.click();

    // All that is assertable here: `window.print()` opens a native dialog that
    // Playwright cannot drive, so the actual printout is verified by hand.
    await expect(viewer.printFrame).toBeAttached();
  });

  test('opens the viewer from a behavior event', async ({ page }) => {
    await stubShell(page);
    await page.route(
      `**/api/v1/children/${STUDENT_GUID}/behavior/${BEHAVIOR_ID}/files/*`,
      fulfillAttachment,
    );
    await page.route(`**/api/v1/children/${STUDENT_GUID}/behavior/${BEHAVIOR_ID}`, (route) =>
      json(route, makeBehaviorDetail([FILES[0]])),
    );

    await page.goto(`/children/${STUDENT_GUID}/behavior/${BEHAVIOR_ID}`);
    await expect(page.getByTestId(`behavior-detail-${BEHAVIOR_ID}`)).toBeVisible();

    const viewer = new AttachmentViewerPage(page);
    await viewer.open('file-png');

    await expect(viewer.title).toHaveText('photo.png');
    await expect(viewer.imagePreview).toBeVisible();
  });

  test('opens the viewer from a mail message', async ({ page }) => {
    await stubShell(page);
    await page.route(
      `**/api/v1/mail/conversations/${CONVERSATION_ID}/messages/${MESSAGE_ID}/files/*`,
      fulfillAttachment,
    );
    await page.route(`**/api/v1/mail/conversations/${CONVERSATION_ID}`, (route) =>
      json(route, makeConversationDetail([FILES[0]])),
    );

    await page.goto(`/inbox/${CONVERSATION_ID}`);

    const viewer = new AttachmentViewerPage(page);
    await expect(viewer.list).toBeVisible();
    await viewer.open('file-png');

    await expect(viewer.title).toHaveText('photo.png');
    await expect(viewer.imagePreview).toBeVisible();
  });
});
