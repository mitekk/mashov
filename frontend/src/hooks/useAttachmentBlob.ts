'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AttachmentError, ATTACHMENT_TIMEOUT_CODE } from '@/lib/attachment-errors';
import { previewKindFor, resolveMimeType, type PreviewKind } from '@/lib/mime';

/**
 * Just above the proxy's own attachment budget (PROXY_ATTACHMENT_TIMEOUT_MS,
 * default 45s) — so a hung route still terminates in the UI with a message of
 * ours instead of spinning forever, but a request the proxy would have
 * answered is never cut off from this side.
 */
const ATTACHMENT_FETCH_TIMEOUT_MS = 48_000;

/** Beyond this, a text preview is truncated rather than handed to the DOM
 * whole: a multi-megabyte CSV would otherwise jank the main thread. */
export const TEXT_PREVIEW_LIMIT_BYTES = 512 * 1024;

interface FetchedAttachment {
  blob: Blob;
  contentType: string | null;
}

export interface UseAttachmentBlobResult {
  blob: Blob | undefined;
  /** Resolved type — header when informative, filename extension otherwise. */
  mimeType: string;
  previewKind: PreviewKind;
  /** Live object URL for the current blob, or `null` while there is none.
   * Owned by this hook: revoked when the blob changes or the hook unmounts. */
  objectUrl: string | null;
  /** Decoded text, for `previewKind === 'text'` only. */
  text: string | null;
  isTextTruncated: boolean;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
}

/** Fires the derived signal when either input signal aborts. Hand-rolled
 * rather than `AbortSignal.any`, which is too new to rely on here. */
function combineSignals(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();

  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), {
      once: true,
    });
  }

  return controller.signal;
}

/** Build a typed error from a non-OK response, reading the
 * `{ error: { code, message } }` envelope when the body is JSON. */
async function toAttachmentError(response: Response): Promise<AttachmentError> {
  let code = `HTTP_${response.status}`;

  if ((response.headers.get('content-type') ?? '').includes('application/json')) {
    try {
      const body = (await response.json()) as {
        error?: { code?: unknown; message?: unknown };
      };
      if (typeof body?.error?.code === 'string' && body.error.code.length > 0) {
        code = body.error.code;
      }
    } catch {
      // Body was labelled JSON but isn't; the status-derived code stands.
    }
  }

  return new AttachmentError(response.status, code);
}

async function fetchAttachment(
  href: string,
  signal: AbortSignal,
): Promise<FetchedAttachment> {
  let response: Response;
  try {
    response = await fetch(href, {
      credentials: 'same-origin',
      signal: combineSignals([signal, AbortSignal.timeout(ATTACHMENT_FETCH_TIMEOUT_MS)]),
    });
  } catch {
    // Timeout, abort or transport failure — nothing ever came back.
    throw new AttachmentError(0, ATTACHMENT_TIMEOUT_CODE);
  }

  if (!response.ok) {
    throw await toAttachmentError(response);
  }

  const contentType = response.headers.get('content-type');

  let blob: Blob;
  try {
    blob = await response.blob();
  } catch {
    throw new AttachmentError(0, ATTACHMENT_TIMEOUT_CODE);
  }

  return { blob, contentType };
}

/**
 * Fetch one attachment as a `Blob` and keep a live object URL for it.
 *
 * Why a blob rather than pointing `<img>`/`<iframe>` at the URL: the backend
 * sends `Content-Disposition: attachment`, which an iframe would honour by
 * downloading; the client is never told a file's MIME type in its payload, and
 * reading the response header gives us the real one; and one fetch then serves
 * preview, Download and Print alike.
 *
 * TanStack owns the fetch (so this does not become the raw `useEffect + fetch`
 * that `.claude/rules/frontend.md` bans for server state) and caches the
 * *blob*. The object URL is deliberately **not** cached: it is minted by an
 * effect keyed on blob identity and revoked on the way out, so next/prev
 * revokes the outgoing URL before minting the next one and an unmount —
 * Radix drops `Dialog.Content` on close — revokes the last.
 */
export function useAttachmentBlob(
  href: string,
  fileName: string,
  { enabled = true }: { enabled?: boolean } = {},
): UseAttachmentBlobResult {
  const query = useQuery<FetchedAttachment>({
    queryKey: ['attachment', href],
    queryFn: ({ signal }) => fetchAttachment(href, signal),
    enabled: enabled && href.length > 0,
    retry: 0,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  });

  const blob = query.data?.blob;

  const mimeType = useMemo(
    () => resolveMimeType(query.data?.contentType, fileName),
    [query.data?.contentType, fileName],
  );
  const previewKind = useMemo(
    () => previewKindFor(mimeType, fileName),
    [mimeType, fileName],
  );

  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob) {
      setObjectUrl(null);
      return;
    }

    const url = URL.createObjectURL(blob);
    setObjectUrl(url);

    return () => {
      URL.revokeObjectURL(url);
      setObjectUrl(null);
    };
  }, [blob]);

  const [text, setText] = useState<string | null>(null);
  const [isTextTruncated, setIsTextTruncated] = useState(false);

  useEffect(() => {
    if (!blob || previewKind !== 'text') {
      setText(null);
      setIsTextTruncated(false);
      return;
    }

    let cancelled = false;
    const truncated = blob.size > TEXT_PREVIEW_LIMIT_BYTES;
    const slice = truncated ? blob.slice(0, TEXT_PREVIEW_LIMIT_BYTES) : blob;

    void slice
      .text()
      .then((value) => {
        if (cancelled) return;
        setText(value);
        setIsTextTruncated(truncated);
      })
      .catch(() => {
        if (cancelled) return;
        setText(null);
        setIsTextTruncated(false);
      });

    return () => {
      cancelled = true;
    };
  }, [blob, previewKind]);

  return {
    blob,
    mimeType,
    previewKind,
    objectUrl,
    text,
    isTextTruncated,
    isLoading: query.isPending && query.fetchStatus === 'fetching',
    isError: query.isError,
    error: query.error,
    refetch: () => void query.refetch(),
  };
}
