FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3333

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3333

CMD ["npm", "start"]
