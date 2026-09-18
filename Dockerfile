FROM node:24-bookworm

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=7000
ENV HEADLESS=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package*.json ./

RUN npm ci

RUN npx patchright install --with-deps chromium

COPY . .

EXPOSE 7000

CMD ["npm", "start"]