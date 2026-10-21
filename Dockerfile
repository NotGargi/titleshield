# One image for the API (serves the web app too) and the Temporal worker.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY packages packages
COPY apps apps
COPY contracts contracts
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /app/data/pki /app/data/chain /app/data/worm && chown -R node:node /app/data
USER node
EXPOSE 8080 8545
CMD ["npm", "run", "start", "-w", "apps/server"]
