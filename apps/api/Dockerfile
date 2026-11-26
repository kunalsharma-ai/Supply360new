# syntax=docker/dockerfile:1
FROM node:26.13.1-bookworm-slim AS build
WORKDIR /repo
RUN npm i -g pnpm@12.23.0
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json turbo.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm install --frozen-lockfile --filter @s360/api... && pnpm --filter @s360/api... build
RUN pnpm --filter @s360/api deploy --prod /out && cp -r packages/db/migrations /out/migrations

FROM node:26.13.1-bookworm-slim
ARG S360_VERSION=dev
ENV S360_VERSION=$S360_VERSION
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
COPY --from=build /repo/packages/db/dist ./packages/db/dist
COPY --from=build /repo/packages/db/migrations ./packages/db/migrations
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]
