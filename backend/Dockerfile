FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
RUN apk add --no-cache openssl
RUN addgroup -S app && adduser -S app -G app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json
USER app
EXPOSE 3000
# The school-year migration runs between `db push` and the app, never after.
# `db push` adds the schoolYear columns at 0 and swaps the unique keys in one
# step; if the app started first, its crons would upsert on the new key, miss
# every `schoolYear = 0` row and duplicate the whole history. Postgres parses
# the file's own SQL comments, and every statement in it is idempotent, so this
# is a cheap no-op on every later boot. Failing here deliberately blocks
# startup rather than serving duplicated data.
CMD ["sh", "-c", "npx prisma db push --accept-data-loss --skip-generate && npx prisma db execute --schema prisma/schema.prisma --file prisma/migrations/20261117000000_school_year_scoping/migration.sql && node dist/src/main.js"]
