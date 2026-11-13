# The headless ward runner (src/headless.ts). Set BIOSENTRY_API_URL and BIOSENTRY_INGEST_KEY; WARD_SPEED
# is the starting speed. Mount a volume at /state to keep the ward across restarts. The lab worker (src/lab-worker.ts) is in the same image: run it with node dist/lab/lab-worker.js.
FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY scenarios ./scenarios
COPY tsconfig.json vite.config.ts ./
RUN npx vite build --ssr src/headless.ts --outDir dist/ward
RUN npx vite build --ssr src/compare.ts --outDir dist/compare && npx vite build --ssr src/lab-worker.ts --outDir dist/lab

# The built file has no npm dependencies: it needs only node (global fetch).
FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
WORKDIR /app
COPY --from=build /app/dist/ward ./dist/ward
COPY --from=build /app/dist/compare ./dist/compare
COPY --from=build /app/dist/lab ./dist/lab
COPY --from=build /app/scenarios/hospital ./scenarios/hospital
RUN mkdir /state && chown node:node /state
ENV WARD_STATE_FILE=/state/ward-state.json
USER node
CMD ["node", "dist/ward/headless.js"]
