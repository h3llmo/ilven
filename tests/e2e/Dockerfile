FROM node:22-alpine
WORKDIR /e2e
COPY tests/e2e/e2e.test.mjs ./
USER node
CMD ["node", "--test", "--test-reporter=spec", "e2e.test.mjs"]
