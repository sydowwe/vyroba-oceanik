FROM node:22-alpine

ARG GIT_SHA=dev
ENV NODE_ENV=production \
    PORT=3000 \
    GIT_SHA=$GIT_SHA
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY vyroba_oceanik_7.html ./

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server/server.js"]
