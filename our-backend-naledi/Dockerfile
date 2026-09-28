# Builds a container image for one of our Node servers, selected at build
# time via SERVER_FILE (frontdoor-bap-server.js, backbone-bpp-server.js or the
# test stand-in mock-mjourney.js). All of them are plain Node http servers
# with zero npm dependencies (they share netlib.js and the v1-*.js modules),
# so this stays intentionally minimal.
FROM node:18-alpine
WORKDIR /app
ARG SERVER_FILE
COPY *.js ./
ENV SERVER_FILE=${SERVER_FILE}
# Using shell form so the ENV var expands at container start.
CMD node ${SERVER_FILE}
