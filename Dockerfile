FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY package.json server.js db.js ./
COPY public ./public
# The database lives here: mount a persistent volume on /app/data.
RUN mkdir -p /app/data && chown node:node /app/data
ENV DB_PATH=/app/data/prowler.db
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1
CMD ["node", "server.js"]
