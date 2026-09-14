FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server ./server
COPY db ./db
USER node
EXPOSE 4300
CMD ["node","server/index.mjs"]
