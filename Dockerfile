FROM node:20-alpine

LABEL maintainer="MajorAchilles <amlanjyoti.s@gmail.com>"
LABEL description="Ghost → GitHub webhook relay for blog content backup"
LABEL version="1.0"

WORKDIR /app

# No npm dependencies — uses only Node built-ins
COPY server.js .

# Non-root user for security
RUN addgroup -S relay && adduser -S relay -G relay
USER relay

EXPOSE 2369

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:2369/health || exit 1

CMD ["node", "server.js"]
