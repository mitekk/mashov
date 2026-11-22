import { extractBehaviorFiles, extractHomeworkFiles, parseAttachmentMeta } from './attachment-parser';

describe('parseAttachmentMeta', () => {
  it.each([null, undefined, 'a string', 42, []])('refuses %p, which is not an attachment', (value) => {
    expect(parseAttachmentMeta(value)).toBeNull();
  });

  it('refuses an object with no identifier, since there would be nothing to fetch', () => {
    expect(parseAttachmentMeta({ fileName: 'אישור.pdf' })).toBeNull();
  });

  it.each(['fileId', 'id', 'guid', 'attachmentId'])('reads the identifier from %s', (key) => {
    expect(parseAttachmentMeta({ [key]: 'file-7' })?.fileId).toBe('file-7');
  });

  it.each(['fileName', 'name', 'title', 'originalFileName'])('reads the name from %s', (key) => {
    expect(parseAttachmentMeta({ id: 'file-7', [key]: 'אישור.pdf' })?.fileName).toBe('אישור.pdf');
  });

  it('falls back to the identifier when no name was sent', () => {
    expect(parseAttachmentMeta({ id: 'file-7' })?.fileName).toBe('file-7');
  });

  it.each(['url', 'link', 'downloadUrl', 'href'])('reads the url from %s', (key) => {
    expect(parseAttachmentMeta({ id: 'f', [key]: '/api/files/f' })?.url).toBe('/api/files/f');
  });

  it('omits the url rather than carrying an empty one', () => {
    expect(parseAttachmentMeta({ id: 'f', url: '   ' })).not.toHaveProperty('url');
  });

  it('trims the whitespace upstream puts around its strings', () => {
    expect(parseAttachmentMeta({ id: ' file-7 ', name: ' אישור.pdf ' })).toMatchObject({
      fileId: 'file-7',
      fileName: 'אישור.pdf',
    });
  });

  it('reads a numeric lessonId, and falls back to the one it was given', () => {
    expect(parseAttachmentMeta({ id: 'f', lessonId: '90' }, 12)?.lessonId).toBe(90);
    expect(parseAttachmentMeta({ id: 'f' }, 12)?.lessonId).toBe(12);
    expect(parseAttachmentMeta({ id: 'f' })).not.toHaveProperty('lessonId');
  });
});

describe('extractBehaviorFiles', () => {
  it('reads from rawPayload, because behavior_item has no files column', () => {
    const files = extractBehaviorFiles(
      { files: [{ id: 'f1', name: 'מכתב.pdf' }] },
      12,
    );

    expect(files).toEqual([{ fileId: 'f1', fileName: 'מכתב.pdf', lessonId: 12 }]);
  });

  it('reads an `attachments` key as well as a `files` one', () => {
    const files = extractBehaviorFiles(
      { files: [{ id: 'f1' }], attachments: [{ id: 'f2' }] },
      12,
    );

    expect(files.map((file) => file.fileId)).toEqual(['f1', 'f2']);
  });

  it.each([null, undefined, 'not json', 7, {}, { files: 'nope' }])(
    'returns nothing for %p',
    (payload) => {
      expect(extractBehaviorFiles(payload, 12)).toEqual([]);
    },
  );

  it('drops an entry it cannot identify rather than returning a half-built one', () => {
    const files = extractBehaviorFiles({ files: [{ name: 'אין מזהה' }, { id: 'f2' }] }, 12);

    expect(files.map((file) => file.fileId)).toEqual(['f2']);
  });
});

describe('extractHomeworkFiles', () => {
  it('reads the homework_item.files column', () => {
    expect(extractHomeworkFiles([{ fileId: 'f1', fileName: 'דף.pdf' }])).toEqual([
      { fileId: 'f1', fileName: 'דף.pdf' },
    ]);
  });

  it.each([null, undefined, {}, 'nope'])('returns nothing for %p', (value) => {
    expect(extractHomeworkFiles(value)).toEqual([]);
  });
});
