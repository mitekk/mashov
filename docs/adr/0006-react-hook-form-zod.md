# ADR-0006: Form Validation — React Hook Form + Zod

- **Date**: 2026-03-11
- **Status**: Accepted
- **Deciders**: Frontend agent (Step 3 implementation)

## Context and Problem Statement

The application includes user-facing forms: a login form (email + password) and potentially filter/search controls in later phases. Each form requires field-level validation with inline error messages, accessible error states, and integration with the API client layer. A decision was needed on the validation library and the schema definition approach for the frontend, taking into account that Zod was already chosen for schema definition in the backend (Prisma + NestJS validation pipes).

## Decision Drivers

- Forms must show field-level validation errors inline, not only on submit
- Validation schemas should be reusable and composable — the same email format rule should not be duplicated across forms
- The backend already uses Zod-compatible schema definitions; aligning the frontend on Zod reduces the schema surface developers need to understand
- Accessibility: form inputs require associated error messages linked via `aria-describedby`; the chosen library must not fight this
- No `any` types — the form value types must be inferred from the schema rather than declared redundantly

## Considered Options

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **React Hook Form v7 + Zod (via `@hookform/resolvers`)** | Uncontrolled inputs — no re-render on every keystroke; Zod resolver infers TypeScript types from schema automatically; field-level errors available at `formState.errors`; integrates cleanly with Radix UI primitives via `register`; no hidden `any` types | Small additional dependency (`@hookform/resolvers`) for the resolver bridge | **Selected** |
| Formik + Yup | Mature and widely documented; Yup is a capable schema library | Controlled inputs cause re-render on every keystroke — noticeable on mobile; Yup schemas require separate TypeScript type declarations or `InferType`; Zod is preferred project-wide; Formik is in maintenance mode | Rejected |
| Native HTML5 validation only | Zero dependencies | No programmatic field-level error control; no custom message formatting; inaccessible error patterns; cannot validate async constraints (e.g., email uniqueness) | Rejected |
| TanStack Form | Modern, type-safe; designed for Next.js | Adds another query-adjacent library from the same vendor; less community adoption; no clear advantage over RHF + Zod for this use case | Rejected |

## Decision Outcome

**Chosen**: React Hook Form v7 with Zod resolver

**Rationale**: React Hook Form's uncontrolled input model means login and filter forms do not trigger full component re-renders on each keystroke — this matters on mobile devices where the JavaScript main thread is the bottleneck. The Zod resolver bridges RHF to the project's Zod schemas, so the form value type is inferred from the schema (`z.infer<typeof LoginSchema>`) with no duplicate type declaration. This also means the same Zod schema can be used server-side for API validation if the schema is published to a shared package in Phase 2. Field-level error messages are available at `formState.errors.fieldName.message` and can be mapped directly to accessible `<p aria-live="polite">` elements below each input, satisfying the a11y requirement without library-specific wrappers.

**Positive Consequences**:
- Form value types are automatically inferred from Zod schemas — no `interface LoginForm { email: string; password: string }` to maintain separately
- Uncontrolled inputs keep the login form responsive on low-end mobile devices
- Zod's error messages are customizable at the schema level (`z.string().email('Enter a valid email address')`) — consistent error copy across frontend and potential backend reuse

**Negative Consequences / Risks**:
- The `@hookform/resolvers` package is a bridge dependency — it must be kept in sync with React Hook Form major versions
- Radix UI form primitives (Label, Input) require explicit wiring of `id`/`htmlFor` and `aria-describedby` for error messages; React Hook Form does not inject these automatically — developers must follow the accessible form pattern on each new form

## Links

- Related: [ADR-0003 — Next.js App Router](0003-nextjs-app-router.md)
- Related: [ADR-0004 — Prisma ORM](0004-prisma-orm.md) (Zod used project-wide for schema definitions)
- Implemented in: `frontend/src/app/`, `frontend/package.json`
