import React from 'react';
import { ExternalLink } from 'lucide-react';

/**
 * The one place in this app that sends a parent to web.mashov.info, and the
 * only reason it exists.
 *
 * ## Why there is no Turnstile widget here
 *
 * After repeated failures Mashov escalates to a Cloudflare Turnstile challenge
 * (`403 Reason: UserSuspended`, our `CAPTCHA_REQUIRED`). The plan was to mount
 * the widget ourselves with Mashov's site key `0x4AAAAAACI5UnCCPR536XNv` and
 * pass the token through in the login body's `captcha` field.
 *
 * That was tested before being built, and it does not work. Rendering that key
 * on a non-mashov.info origin (`http://127.0.0.1:8777`) returns Cloudflare
 * error **110200** -- "domain not allowed". Cloudflare site keys carry a domain
 * allow-list and Mashov's is theirs, so no token we could obtain would satisfy
 * it. A server-side axios call cannot solve a challenge either.
 *
 * So this is the fallback the plan named for exactly that outcome: a single
 * escape-hatch link, shown ONLY on `CAPTCHA_REQUIRED` and never in the happy
 * path. It contradicts the never-navigate-away goal, which is why it is a last
 * resort -- but a locked-out parent with no path at all is worse, and that is
 * the situation Mashov puts them in.
 *
 * `buildLoginBody` still forwards an optional `captcha`, so if Mashov ever
 * allow-lists our domain the widget becomes a small, additive change.
 */
export function CaptchaEscapeHatch({ testIdPrefix }: { testIdPrefix: string }) {
  return (
    <div
      data-testid={`${testIdPrefix}-captcha-escape`}
      className="rounded-xl bg-muted/50 p-3 text-xs text-muted-foreground"
    >
      <p>
        משוב מבקש אימות &quot;אני לא רובוט&quot; שאפשר להשלים רק באתר של משוב. יש להיכנס
        שם פעם אחת, ואז לחזור לכאן ולהתחבר כרגיל.
      </p>
      <a
        href="https://web.mashov.info/students/login"
        data-testid={`${testIdPrefix}-captcha-escape-link`}
        // New tab, so the half-filled form here survives; `noreferrer` so our
        // URL -- which on some of these screens carries a recovery handle --
        // is not sent along.
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-flex items-center gap-1.5 font-semibold text-primary underline-offset-4 hover:underline"
      >
        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        פתיחת האימות באתר משוב
      </a>
    </div>
  );
}
