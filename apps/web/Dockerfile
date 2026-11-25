# syntax=docker/dockerfile:1
FROM node:26.13.1-bookworm-slim AS build
WORKDIR /repo
RUN npm i -g pnpm@12.23.0
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json turbo.json ./
COPY packages ./packages
COPY apps/web ./apps/web
# Next.js bakes rewrite destinations in at build time.
ARG S360_API_URL=http://api:4000
ENV S360_API_URL=$S360_API_URL
RUN pnpm install --frozen-lockfile --filter @s360/web... && pnpm --filter @s360/web... build

FROM node:26.13.1-bookworm-slim
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
