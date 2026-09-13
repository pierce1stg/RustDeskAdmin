# Build args for all downstream FROM images; explicit so fallback mirrors work.
ARG DOCKER_REGISTRY_PREFIX=

# Development stage
FROM ${DOCKER_REGISTRY_PREFIX:-}node:20-alpine AS development

ARG NPM_REGISTRY

ENV NPM_CONFIG_REGISTRY=${NPM_REGISTRY:-https://registry.npmjs.org}

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

# Builder stage
FROM ${DOCKER_REGISTRY_PREFIX:-}node:20-alpine AS builder

ARG NPM_REGISTRY

ENV NPM_CONFIG_REGISTRY=${NPM_REGISTRY:-https://registry.npmjs.org}

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && rm -rf /root/.npm /tmp/npm-*

COPY . .
RUN npm run build

# Production stage
FROM ${DOCKER_REGISTRY_PREFIX:-}nginx:alpine AS production

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]