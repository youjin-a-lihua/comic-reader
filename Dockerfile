# 通用漫画阅读器 — 容器镜像
# 构建：docker build -t comic-reader .
# 运行：docker run -p 3000:3000 -v $(pwd)/comics:/comics -v comic-data:/app/data comic-reader
FROM node:20

WORKDIR /app

# 先装依赖（利用层缓存；sharp 走 npm 预编译二进制，无需本机编译）
COPY package.json ./
RUN npm install --omit=dev

# 再拷源码
COPY . .

# 默认漫画目录与数据目录（运行时用卷挂载持久化）
RUN mkdir -p /comics /app/data \
 && chown -R node:node /app /comics

ENV PORT=3000 \
    COMICS_DIR=/comics \
    DATA_DIR=/app/data \
    ONLINE_SOURCE=

EXPOSE 3000

# 数据（JWT 密钥、用户、书架、AstrBot 配置等）落在 /app/data，请挂卷持久化
VOLUME ["/comics", "/app/data"]

USER node

CMD ["node", "server.js"]
