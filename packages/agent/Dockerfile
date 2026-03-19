FROM node:20-alpine AS builder

WORKDIR /build

# Copy workspace root
COPY package.json tsconfig.base.json ./

# Copy package manifests
COPY packages/agent/package.json ./packages/agent/
COPY packages/mcp-url-fetcher/package.json ./packages/mcp-url-fetcher/

# Install all dependencies
RUN npm install --workspaces

# Copy source
COPY packages/agent/src ./packages/agent/src
COPY packages/agent/tsconfig.json ./packages/agent/
COPY packages/mcp-url-fetcher/src ./packages/mcp-url-fetcher/src
COPY packages/mcp-url-fetcher/tsconfig.json ./packages/mcp-url-fetcher/

# Build
RUN npm run -w @squirrel/agent build
RUN npm run -w @squirrel/mcp-url-fetcher build

# ---------------------------------------------------------------------------
FROM node:20-alpine AS runtime

WORKDIR /app

# Copy built output and production dependencies
COPY --from=builder /build/packages/agent/dist ./packages/agent/dist
COPY --from=builder /build/packages/agent/package.json ./packages/agent/
COPY --from=builder /build/packages/mcp-url-fetcher/dist ./packages/mcp-url-fetcher/dist
COPY --from=builder /build/packages/mcp-url-fetcher/package.json ./packages/mcp-url-fetcher/
COPY --from=builder /build/node_modules ./node_modules
COPY package.json ./

# Pre-install the pre-built MCP servers so npx doesn't fetch at runtime
RUN npm install -g \
  @modelcontextprotocol/server-gdrive \
  @modelcontextprotocol/server-github

ENV NODE_ENV=production

CMD ["node", "/app/packages/agent/dist/index.js"]
