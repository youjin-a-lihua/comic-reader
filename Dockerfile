# 通用漫画阅读器 — 容器镜像
# 构建：docker build -t comic-reader .
# 运行：docker run -p 3000:3000 -v $(pwd)/comics:/comics -v comic-data:/app/data comic-reader
FROM node:22-alpine

ARG VERSION=dev

WORKDIR /app

# libarchive-tools 提供 bsdtar：unrar 在多数发行版属 non-free，装不上就会让 CBR 完全不可用；
# bsdtar 在主仓库里，能读 RAR / RAR5 / ZIP，lib/cbz.js 会自动回退到它。
# tzdata 让 TZ 环境变量真正生效。
RUN apk add --no-cache libarchive-tools tzdata \
 && ln -snf /usr/share/zoneinfo/Etc/UTC /etc/localtime

# 先装依赖（利用层缓存）。package-lock.json 一起拷，保证构建可复现。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 再拷源码
COPY . .

# 默认漫画目录与数据目录（运行时用卷挂载持久化）
# chmod 保证镜像内文件对所有用户可读，避免宿主机 umask 过严导致 COPY 后无读权限
RUN mkdir -p /comics /app/data \
 && chown -R node:node /app /comics \
 && chmod -R a+rX /app /comics

ENV PORT=3000 \
    COMICS_DIR=/comics \
    DATA_DIR=/app/data \
    ONLINE_SOURCE=

LABEL org.opencontainers.image.title="comic-reader" \
      org.opencontainers.image.description="Self-hosted comic/manga/novel reader (PDF/CBZ/CBR/EPUB) with pluggable online sources" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/youjin-a-lihua/comic-reader"

EXPOSE 3000

# 探活不依赖 curl/wget：镜像里一定有的只有 node 本身
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# 数据（JWT 密钥、用户、书架、批注等）落在 /app/data，请挂卷持久化
VOLUME ["/comics", "/app/data"]

USER node

CMD ["node", "server.js"]
