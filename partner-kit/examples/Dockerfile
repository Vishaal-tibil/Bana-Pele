# Builds the reference partner app (test aid; build context is partner-kit/).
FROM node:18-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY network-kit ./network-kit
COPY examples ./examples
CMD ["node", "examples/reference-app.js"]
