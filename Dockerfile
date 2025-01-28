# Use Node.js image with proper temp directory handling
FROM node:18-slim

# Set working directory with write permissions
WORKDIR /home/node/app
RUN chown -R node:node /home/node/app

# Install dependencies with cleanup
RUN apt-get update && \
    apt-get install -y \
    wget \
    handbrake-cli \
    zlib1g-dev \
    && wget -O /tmp/libssl.deb https://mirrors.tuna.tsinghua.edu.cn/debian/pool/main/o/openssl/libssl1.1_1.1.1w-0+deb11u1_amd64.deb \
    && dpkg -i /tmp/libssl.deb \
    && rm /tmp/libssl.deb \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Copy files as non-root user
USER node
COPY --chown=node:node package*.json ./
RUN npm install
COPY --chown=node:node . .

# Make binary executable
RUN chmod +x ./telegram-bot-api

# Use Hugging Face compatible ports
EXPOSE 7860 8081

# Set environment variables for Hugging Face
ENV PORT=7860
ENV TMP_DIR=/tmp

CMD ["node", "index.js"]