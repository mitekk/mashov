# Docker Rules

Applies to all Dockerfile and docker-compose.yml authoring.

## Every Service Needs

- A `Dockerfile` (multi-stage: `builder` + `runner`)
- An entry in `docker-compose.yml`
- A health check (container-level for compose; endpoint-level for the app)

## Dockerfile Standards

```dockerfile
# builder stage: compile/install
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# runner stage: minimal final image
FROM node:22-alpine AS runner
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
USER app
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

Key rules:
- Always run as a non-root user in the final image
- Copy only what's needed (no `COPY . .` in the runner stage)
- Use specific version tags, not `latest`

## docker-compose.yml Standards

```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: ${DB_NAME}
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - db_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER}"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

  backend:
    build: ./backend
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
    environment:
      DATABASE_URL: ${DATABASE_URL}
      REDIS_URL: ${REDIS_URL}
    ports:
      - "3000:3000"

volumes:
  db_data:
```

Key rules:
- DB and Redis must have `healthcheck` defined
- App services use `depends_on` with `condition: service_healthy`
- All config via environment variables — never hard-coded values
- Named volumes for all persistent data
- Never commit `.env`; always provide `.env.example` with placeholder values

## Health Check Endpoint

Every backend app must expose `GET /health` returning:
```json
{ "status": "ok" }
```
HTTP 200. This endpoint should verify DB connectivity (quick ping, not a full query).
