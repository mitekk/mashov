# Mashov Parent Command Center

A mobile-first household dashboard built on top of the [Mashov](https://web.mashov.info) Israeli school API. Gives parents a single, aggregated briefing screen: what changed across all children, which child needs attention, and what school messages are waiting.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose v2
- Node.js 22+ (for local development without Docker)

## Quick Start (Docker)

```bash
cp .env.example .env
# Fill in your Mashov credentials in .env
docker compose up --build
```

- Frontend: http://localhost:3001
- Backend API: http://localhost:3000
- Health check: http://localhost:3000/health

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
| `CORS_ORIGIN` | Allowed CORS origin(s), comma-separated | `http://localhost:3001` |
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
| Frontend (Next.js) | 3001 |
| Backend (NestJS) | 3000 |
| PostgreSQL | 5432 |
| Redis | 6379 |

## Project Structure

```
frontend/     Next.js + TypeScript UI
backend/      NestJS + TypeScript API + sync engine
docs/         Architecture, ADRs, API contract, PRD
tests/        Integration and E2E tests
```
