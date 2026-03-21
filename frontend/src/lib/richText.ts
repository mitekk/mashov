'use client';

import DOMPurify from 'dompurify';

export interface SanitizedRichTextResult {
  sanitizedHtml: string;
  plainTextPreview: string;
}

interface SanitizeRichTextOptions {
  fallbackText?: string;
}

const DEFAULT_FALLBACK_TEXT = 'תוכן לא זמין';

const ALLOWED_TAGS = [
  'a',
  'blockquote',
  'br',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'li',
  'ol',
  'p',
  'strong',
  'u',
  'ul',
];

const ALLOWED_ATTR = ['href', 'rel', 'target', 'title'];

const FORBIDDEN_PRESENTATIONAL_ATTRS = [
  'align',
  'bgcolor',
  'class',
  'color',
  'face',
  'lang',
  'style',
  'valign',
  'width',
];

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toPlainText(html: string): string {
  if (typeof window !== 'undefined' && typeof window.DOMParser !== 'undefined') {
    const parser = new window.DOMParser();
    const document = parser.parseFromString(`<div>${html}</div>`, 'text/html');
    return normalizeWhitespace(document.body.textContent ?? '');
  }

  return normalizeWhitespace(html.replace(/<[^>]*>/g, ' '));
}

export function sanitizeRichTextHtml(
  rawHtml: string,
  options: SanitizeRichTextOptions = {},
): SanitizedRichTextResult {
  const fallbackText = normalizeWhitespace(options.fallbackText ?? DEFAULT_FALLBACK_TEXT) || DEFAULT_FALLBACK_TEXT;
  const safeRawHtml = typeof rawHtml === 'string' ? rawHtml : '';

  const sanitizedHtml = DOMPurify.sanitize(safeRawHtml, {
    ALLOWED_ATTR,
    ALLOWED_TAGS,
    FORBID_ATTR: FORBIDDEN_PRESENTATIONAL_ATTRS,
    USE_PROFILES: { html: true },
  });

  const plainTextPreview = toPlainText(sanitizedHtml);
  if (plainTextPreview.length > 0) {
    return { sanitizedHtml, plainTextPreview };
  }

  return {
    sanitizedHtml: `<p>${escapeHtml(fallbackText)}</p>`,
    plainTextPreview: fallbackText,
  };
}
