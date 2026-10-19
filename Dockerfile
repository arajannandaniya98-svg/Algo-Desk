# AlgoDesk India — production image (used by docker-compose.yml)
FROM node:22-alpine AS base
RUN apk add --no-cache tzdata
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build-time placeholder only; the real DATABASE_URL comes from docker-compose.
ENV DATABASE_URL=postgresql://postgres:postgres@db:5432/app_db
RUN npm run build

FROM base AS run
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app ./
EXPOSE 3000
CMD ["npm", "start"]
