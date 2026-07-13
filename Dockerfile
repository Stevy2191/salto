# Build stage: compile the frontend
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Runtime stage: slim image with the server and built frontend only
FROM node:24-alpine
LABEL org.opencontainers.image.source="https://github.com/Stevy2191/salto"
LABEL org.opencontainers.image.description="Salto — rotation scheduling for gymnastics gyms"
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY shared ./shared
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "server/index.ts"]
