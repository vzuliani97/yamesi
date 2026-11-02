FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.30.6-alpine
# Apply Alpine security fixes published after the base image was built, then drop back to the nginx user.
USER root
RUN apk upgrade --no-cache
USER 101
COPY nginx.conf /etc/nginx/conf.d/default.conf
# The header snippet names the storage origin that serves presigned photo URLs. nginx's entrypoint
# fills in PHOTO_ORIGIN at start-up; the default matches S3_PUBLIC_ENDPOINT in docker-compose.yml.
ENV PHOTO_ORIGIN=http://localhost:9002
COPY security-headers.conf /etc/nginx/templates/snippets/security-headers.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
