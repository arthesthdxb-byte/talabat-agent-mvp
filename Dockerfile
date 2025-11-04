FROM mcr.microsoft.com/playwright:v1.56.1-jammy
WORKDIR /app

# Only install what we need
COPY package.json ./
RUN npm install --omit=dev

# App code
COPY server.mjs ./

# Runtime config
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.mjs"]
