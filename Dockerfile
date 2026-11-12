# The headless ward runner (src/headless.ts). Set BIOSENTRY_API_URL and BIOSENTRY_INGEST_KEY; WARD_SPEED
# is the starting speed. Mount a volume at /state to keep the ward across restarts.
FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY scenarios ./scenarios
COPY tsconfig.json vite.config.ts ./
RUN npx vite build --ssr src/headless.ts --outDir dist/ward

# The built file has no npm dependencies: it needs only node (global fetch).
FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
WORKDIR /app
COPY --from=build /app/dist/ward ./dist/ward
RUN mkdir /state && chown node:node /state
ENV WARD_STATE_FILE=/state/ward-state.json
USER node
CMD ["node", "dist/ward/headless.js"]
