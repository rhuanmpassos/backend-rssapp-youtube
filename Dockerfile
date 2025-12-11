# ===========================================
# Dockerfile - YouTube Monitor
# ===========================================
# Use este Dockerfile se preferir deploy via Docker no Render

FROM node:20-alpine

WORKDIR /app

# Copia package files primeiro (melhor cache)
COPY package*.json ./

# Instala dependências (sem devDependencies em produção)
RUN npm ci --only=production=false

# Copia código fonte
COPY . .

# Build TypeScript
RUN npm run build

# Remove devDependencies após build
RUN npm prune --production

# Porta padrão (Render sobrescreve via $PORT)
EXPOSE 10000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT:-10000}/api/status || exit 1

# Inicia o servidor
CMD ["node", "dist/main.js"]

