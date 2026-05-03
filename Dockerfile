FROM node:20-alpine

WORKDIR /usr/src/app

ENV NODE_ENV=production

COPY package.json package-lock.json ./

RUN npm ci --omit=dev && npm cache clean --force

COPY app.js ./
COPY config ./config
COPY middleware ./middleware
COPY routers ./routers
COPY services ./services
COPY utils ./utils
COPY jobs ./jobs
COPY scripts ./scripts

RUN mkdir -p uploads && chown -R node:node /usr/src/app

USER node

EXPOSE 3001

CMD ["node", "app.js"]
