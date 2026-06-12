FROM node:22-alpine AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

WORKDIR /app

FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/agent-worker/package.json apps/agent-worker/package.json
COPY apps/integration-gateway/package.json apps/integration-gateway/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN pnpm install --frozen-lockfile

FROM deps AS source

COPY . .

FROM source AS api-runtime

ENV NODE_ENV=production
ENV PORT=3001

RUN apk add --no-cache git && git config --global user.name viwork && git config --global user.email viwork@local

EXPOSE 3001

CMD ["pnpm", "--filter", "@viwork/api", "start"]

FROM source AS web-build

ARG VIWORK_PRODUCT=novel-adaptation
ARG VITE_API_BASE_URL=
ENV VIWORK_PRODUCT=$VIWORK_PRODUCT
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

RUN pnpm --filter @viwork/web build

FROM nginx:1.27-alpine AS web-runtime

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80
