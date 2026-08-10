# syntax=docker/dockerfile:1.7

FROM node:24.5.0-bookworm-slim AS build

ARG BUILD_VERSION=local
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@10.13.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY benchmarks ./benchmarks
COPY examples ./examples
COPY scripts ./scripts
COPY spec ./spec
COPY ops ./ops
COPY deploy ./deploy
COPY deploy/package.json deploy/package-lock.json /opt/deploy-deps/

RUN pnpm install --frozen-lockfile
RUN cd /opt/deploy-deps && npm ci --omit=dev --ignore-scripts --no-audit --no-fund
RUN pnpm build

FROM node:24.5.0-bookworm-slim AS runtime

ARG BUILD_VERSION=local
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    PORT=3000 \
    HOST=0.0.0.0 \
    PREMISE_BUILD_VERSION=${BUILD_VERSION}

RUN groupadd --gid 10001 premise \
 && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/premise --shell /usr/sbin/nologin premise \
 && mkdir -p /app /backup /tmp \
 && chown -R 10001:10001 /app /backup /tmp /home/premise

WORKDIR /app

COPY --from=build --chown=10001:10001 /workspace/package.json ./package.json
COPY --from=build --chown=10001:10001 /workspace/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /workspace/packages ./packages
COPY --from=build --chown=10001:10001 /workspace/ops ./ops
COPY --from=build --chown=10001:10001 /workspace/deploy ./deploy
COPY --from=build --chown=10001:10001 /opt/deploy-deps/node_modules ./deploy/node_modules

USER 10001:10001

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=6 \
  CMD ["node", "/app/ops/healthcheck.mjs"]

LABEL org.opencontainers.image.title="PREMiSE v2" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.source="https://github.com/Dafenxz0/premise-protocol"

CMD ["node", "/app/ops/server.mjs"]
