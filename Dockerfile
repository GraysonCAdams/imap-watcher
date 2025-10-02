# Use official Node.js LTS slim image
FROM node:18-slim

# Create app directory
WORKDIR /usr/src/app

# Install dependencies first (leverage Docker layer cache)
COPY package.json package-lock.json* ./
RUN npm ci --production --no-audit --no-fund

# Copy source
COPY . .

# Expose nothing by default; this is a worker
ENV NODE_ENV=production

# Default command: start the watcher. Provide --simulate for local tests
CMD ["node", "./src/index.js"]
