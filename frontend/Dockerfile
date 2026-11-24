FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN mkdir -p public
# Next inlines every NEXT_PUBLIC_* read in a "use client" module at build time,
# so the version a parent's browser reports has to be known HERE, not at
# runtime. Optional: next.config.ts falls back to this package's own version,
# so an unset APP_VERSION still produces a real string rather than ''.
ARG APP_VERSION=""
ENV APP_VERSION=$APP_VERSION
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# Next does not trace sharp into the standalone output, so the optimizer would
# fail at runtime without these. Copied from the builder (same node:22-alpine
# base) so the musl binary matches this image's libc and architecture.
COPY --from=builder /app/node_modules/sharp ./node_modules/sharp
COPY --from=builder /app/node_modules/@img ./node_modules/@img
# The optimizer writes encoded variants here. Everything above is copied as
# root; the app user needs its own writable cache tree, and a fresh named
# volume mounted on this path inherits this ownership.
RUN mkdir -p .next/cache/images && chown -R app:app .next/cache
USER app
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ["node", "server.js"]
