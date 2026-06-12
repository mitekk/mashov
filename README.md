# Mashov Parent Command Center

> The school portal a busy parent can actually keep up with — every kid's messages, homework & behavior in one daily glance, on top of Israel's [Mashov](https://web.mashov.info) system.

**🔗 Live app: [mashov.mitya.dev](https://mashov.mitya.dev)**

A mobile-first, Hebrew/RTL household dashboard that sits on top of the Mashov Israeli school API. Sign in once with your existing Mashov account and get a single, aggregated briefing across all your children — what changed, who needs attention, and which school messages are waiting.

## What is this?

The school portal already has all your kids' data — it's just exhausting to use day to day. You log in, navigate a heavy legacy interface, switch context between children, and reassemble "what changed" from a half-dozen screens. Every time.

This app removes that. It's a calm, low-click **summary and triage layer** over Mashov that answers one question fast: *what changed, who it affects, and what needs attention right now.* The goal is to understand your whole household's school status in **under 30 seconds**, without hunting through menus.

## What you get

- **📋 One daily briefing** — a single mixed feed of what changed across all your children, newest first.
- **🔔 Attention first** — surfaces who needs you: new unread messages, behavior and attendance events, and recently assigned homework.
- **✉️ Clean inbox** — read school messages without the legacy clutter, with exact unread counts and attachment indicators.
- **🧒 Per-child workspace** — homework history, a behavior & attendance timeline, subjects & teachers, and the weekly timetable for each child.
- **🔑 No new account** — sign in with your existing Mashov school credentials; nothing extra to remember.
- **📱 Mobile-first & RTL** — designed for the phone and built for Hebrew (including mixed Hebrew/English) from the ground up.
- **🔒 Private by default** — each parent gets their own read/handled state, and stored credentials are encrypted at rest.

## How it works

1. **Sign in** — pick your school and log in with your Mashov username and password (the school year is detected automatically).
2. **First sync** — the app pulls your household's latest data once in the background.
3. **Glance** — open it whenever, see what's new across all your kids, and drill into a single message or child only if you need to.

## Good to know

This is a reading and triage companion, **not** a rebuild of the school portal. It's read-only by design and intentionally scoped — it does **not** include grades, report cards, or performance analytics. Think "daily briefing," not "admin portal."

## Tech stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js + TypeScript (mobile-first, RTL) |
| Backend | NestJS + TypeScript + per-household sync engine |
| Database | PostgreSQL |
| Cache / rate limiting | Redis |
| Infrastructure | Docker Compose |

---

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose v2
- Node.js 22+ (for local development without Docker)

## Quick Start (Docker)

```bash
cp .env.example .env
# Fill in your Mashov credentials in .env
docker compose up --build
```

- Frontend: http://localhost:3000
- Backend API: http://localhost:3001
- Health check: http://localhost:3001/health

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://postgres:postgres@db:5432/mashov` |
| `DB_NAME` | Database name | `mashov` |
| `DB_USER` | Database user | `postgres` |
| `DB_PASSWORD` | Database password | `postgres` |
| `MASHOV_SEMEL` | School ID (semel) | `482273` |
| `MASHOV_YEAR` | Academic year | `2026` |
| `MASHOV_USERNAME` | Parent ID number (username) | `your_id_number` |
| `MASHOV_PASSWORD` | Parent password | `your_password` |
| `ENCRYPTION_KEY` | 64-char hex key for encrypting stored credentials | `your_64_hex_chars_here` |
| `REDIS_URL` | Redis connection string | `redis://redis:6379` |
| `SESSION_LIFETIME_DAYS` | Session cookie lifetime in days (rolling) | `30` |
| `SESSION_SECURE_COOKIE` | Set `false` for local dev (no HTTPS) | `false` |
| `CORS_ORIGIN` | Allowed CORS origin(s) for the backend | `http://localhost:3000` |
| `FEATURE_DAILY_BEHAVE` | Enable daily behaviour sync | `false` |
| `FEATURE_OUT_BEHAVE` | Enable out-of-school behaviour sync | `false` |

Copy `.env.example` to `.env` and fill in your values. Never commit `.env`.

## Running Tests (Containers Only)

```bash
# Backend unit tests with coverage (inside container)
npm run test:unit

# Backend API integration tests (inside container)
npm run test:integration

# Full-stack E2E tests with Playwright (inside container)
npm run test:e2e
```

## Local Development (Hot Reload)

`docker-compose.override.yml` is automatically loaded by `docker compose up` and mounts source directories for live reload — no rebuild needed on code changes.

```bash
docker compose up          # hot reload enabled automatically
docker compose down -v     # stop and remove volumes
```

Service ports:

| Service | Port |
|---------|------|
| Frontend (Next.js) | 3000 |
| Backend (NestJS) | 3001 |
| PostgreSQL | 5432 |
| Redis | 6379 |

## Project Structure

```
frontend/     Next.js + TypeScript UI
backend/      NestJS + TypeScript API + sync engine
docs/         Architecture, ADRs, API contract, PRD
tests/        Integration and E2E tests
```
