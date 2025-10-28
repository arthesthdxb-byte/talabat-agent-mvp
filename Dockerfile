FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install && npx playwright install --with-deps
COPY server.mjs ./
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]
