# Builds a container image for one of our Node servers, selected at build
# time via SERVER_FILE (frontdoor-bap-server.js, backbone-bpp-server.js or the
# test stand-in mock-mjourney.js). They share netlib.js, db.js, logger.js and
# the v1-*.js modules; the only npm dependency is "pg" (PostgreSQL).
FROM node:18-alpine
WORKDIR /app
ARG SERVER_FILE
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY *.js ./
ENV SERVER_FILE=${SERVER_FILE}
# Using shell form so the ENV var expands at container start.
CMD node ${SERVER_FILE}
