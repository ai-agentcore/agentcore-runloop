FROM node:22-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
COPY vendor/runloop ./vendor/runloop
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
USER root
RUN sed -i 's|http://deb.debian.org|http://mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends git python3 \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g --registry=https://registry.npmmirror.com @openai/codex@0.155.0 \
    && useradd -m -s /bin/bash coder
WORKDIR /app/agentcore-runloop
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY package.json ./
COPY scripts ./scripts
RUN git --version \
    && python3 --version \
    && node --version \
    && codex --version
ENV HOST=0.0.0.0 \
    PORT=8080 \
    AGENTCORE_EXECUTION=local \
    AGENTCORE_MODEL_ENABLE_THINKING=false \
    AGENTCORE_SKILL_WORKSPACE_DIR=/mnt/agenticfs/shared/.agentcore/skills \
    AGENTCORE_WORKSPACES_DIR=/tmp/agentcore-workspaces \
    PYTHONUNBUFFERED=1
EXPOSE 8080
ENTRYPOINT []
HEALTHCHECK --interval=30s --timeout=5s CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/readyz', timeout=3)"
CMD ["node", "scripts/start.mjs"]
