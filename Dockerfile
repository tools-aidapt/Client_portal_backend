# --- Build stage ---
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- Production stage ---
FROM node:20-alpine AS production
ENV NODE_ENV=production
WORKDIR /app

# Chromium for report PDF export (GET /reports/:id/pdf). We ship the Alpine
# package rather than letting Puppeteer download its own build — Puppeteer's
# bundled Chromium is glibc-linked and will not run on Alpine's musl.
# This is the bulk of the image size; drop it and the PDF route 503s cleanly
# with PDF_NO_BROWSER while every other endpoint keeps working.
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
