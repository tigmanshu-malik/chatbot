FROM node:26-alpine AS checked
WORKDIR /app
COPY package.json .
COPY backend ./backend
COPY frontend ./frontend
RUN node --check backend/server.js

FROM node:26-alpine AS runtime
WORKDIR /app
COPY --from=checked /app /app
ENV HOST=0.0.0.0
ENV PORT=8000
ENV DATABASE_URL=sqlite:////data/app.db
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 8000
CMD ["node","backend/server.js"]
