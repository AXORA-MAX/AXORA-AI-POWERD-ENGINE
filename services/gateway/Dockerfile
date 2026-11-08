FROM node:22-slim
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install --no-save typescript@^5.9.0 @types/node@^22.0.0 \
 && npx tsc -p . \
 && npm prune --omit=dev || true
EXPOSE 8787
CMD ["node", "--experimental-sqlite", "dist/server.js"]
