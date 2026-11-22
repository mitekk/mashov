FROM node:22-alpine AS builder
WORKDIR /app
# Pinned because mail read-state correctness depends on it: naive Mashov
# sendTimes and the stored locallyReadThroughAt watermarks they are compared
# against must parse in one zone. See src/common/process-zone.ts.
ENV TZ=UTC
RUN apk add --no-cache openssl
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
# Pinned because mail read-state correctness depends on it: naive Mashov
# sendTimes and the stored locallyReadThroughAt watermarks they are compared
# against must parse in one zone. See src/common/process-zone.ts.
ENV TZ=UTC
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
# The roster-presence backfill runs here for the same reason: `db push` creates
# lastSeenInRosterAt but cannot fill it, and a NULL is never swept, so without
# this line a child who left the school is never retired. Idempotent, like the
# file above. src/prisma/boot-migrations.spec.ts fails if a migration with data
# statements is added without being executed here or explicitly exempted.
#
# One file runs BEFORE `db push`, and only one: the duplicate-connection
# collapse. `db push` creates @@unique([schoolCode, username]) from
# schema.prisma, and 20261117000000 deactivated rather than deleted the
# duplicate household_connection rows -- so they are still there, and push
# would hit a unique violation and block startup with nothing to roll back to.
# It is guarded with to_regclass, so on a first-ever deploy, where the table
# does not exist until push creates it, it is a no-op rather than an error.
#
# The digest per-user migration runs after push too, and for a reason of its
# own: it does not only add columns, it copies each child's dedup ledger to the
# child's other subscribers. Before that deploy one per-child run delivered to
# every recipient, so without the copy the second parent's first run re-reports
# the whole active window at them. Idempotent, like the files above.
#
# The message-board firstSeenAt backfill runs after push for the same reason:
# push adds the column with DEFAULT now(), which Postgres writes into every
# existing row -- so without the backfill the whole current board looks
# first-seen at deploy time and the next digest run announces all of it at
# once. Idempotent: it only rewrites rows whose firstSeenAt is still later
# than their updatedAt, which a genuinely new row never is.
#
# The ownership backfill runs after push, because push is what adds the
# householdConnectionId columns it fills. Until it has run, every row is
# NULL-stamped -- which MailInboxTask treats as "do not sweep yet" rather than
# as "unowned", so an unrun backfill costs a stale badge, never wrong data.
CMD ["sh", "-c", "npx prisma db execute --schema prisma/schema.prisma --file prisma/migrations/20261120000000_connection_duplicate_collapse/migration.sql && npx prisma db push --accept-data-loss --skip-generate && npx prisma db execute --schema prisma/schema.prisma --file prisma/migrations/20261117000000_school_year_scoping/migration.sql && npx prisma db execute --schema prisma/schema.prisma --file prisma/migrations/20261119010000_roster_presence/migration.sql && npx prisma db execute --schema prisma/schema.prisma --file prisma/migrations/20261120010000_connection_scoping/migration.sql && npx prisma db execute --schema prisma/schema.prisma --file prisma/migrations/20261120020000_connection_unique_keys/migration.sql && npx prisma db execute --schema prisma/schema.prisma --file prisma/migrations/20261121000000_connection_collision_keys/migration.sql && npx prisma db execute --schema prisma/schema.prisma --file prisma/migrations/20261122000000_student_connection_links/migration.sql && npx prisma db execute --schema prisma/schema.prisma --file prisma/migrations/20261124000000_digest_per_user/migration.sql && npx prisma db execute --schema prisma/schema.prisma --file prisma/migrations/20261126000000_message_board_first_seen/migration.sql && node dist/src/main.js"]
