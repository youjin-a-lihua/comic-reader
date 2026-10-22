# Comic Reader

> English version: [README.en.md](README.en.md)

自托管的漫画与小说阅读服务器。一个容器跑起来，浏览器、手机、平板都能读。

- 本地库：扫描 PDF / CBZ / CBR / EPUB，自动生成封面，记录阅读进度
- 加密 PDF：支持自动解密，口令在管理后台或环境变量配置
- EPUB 阅读器：目录、排版设置、批注与高亮、AI 章节总结（见 [ANNOTATIONS.md](ANNOTATIONS.md)）
- 多用户：账号登录、书架、收藏、继续阅读、阅读排行
- 可插拔在线源：搜索 / 在线阅读 / 下载入库，默认关闭（见 [ONLINE_SOURCES.md](ONLINE_SOURCES.md)）
- AstrBot 联动（可选）

更新记录见 [CHANGELOG.md](CHANGELOG.md)。

## 快速开始

镜像发布在 GHCR，支持 linux/amd64 与 linux/arm64，由 GitHub Actions 随每次推送自动构建：

```bash
docker run -d --name comic-reader \
  -p 3000:3000 \
  -e TZ=Asia/Shanghai \
  -v /path/to/comics:/comics \
  -v comic-data:/app/data \
  ghcr.io/youjin-a-lihua/comic-reader:latest
```

或者用 docker compose：

```bash
git clone https://github.com/youjin-a-lihua/comic-reader.git
cd comic-reader
mkdir comics
docker compose up -d      # 改过源码后想立即生效，加 --build
```

打开 `http://<服务器IP>:3000`，第一个注册的账号是管理员。

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `COMICS_DIR` | `/comics` | 本地漫画根目录（挂载卷） |
| `DATA_DIR` | `/app/data` | 运行时数据目录（挂卷持久化） |
| `JWT_SECRET` | 空 | 留空则首次启动自动生成并写入 `DATA_DIR/.jwt-secret`；也可填 ≥32 字符固定串 |
| `ONLINE_SOURCE` | 空（默认关闭） | 启用的在线源；留空则不启用任何在线源。可设为单个（`jm`）、逗号分隔的多个（`jm,kavita`），或 `all` 启用清单里全部（见 `lib/sources/sources.json`） |
| `NOVEL_DIR` | 空 | 小说目录绝对路径；不设则不显示「小说」库 |
| `DECRYPT_PASSWORD` | 空 | 加密 PDF 的打开密码。也可在管理后台填写（存进 `DATA_DIR/settings.json`，优先于本变量）。两处都为空则不解密。口令不会回传前端，审计日志中脱敏为 `***` |

## 文件权限

容器以 uid/gid 1000 运行，需要对漫画目录有读权限、对数据目录有写权限：

```bash
sudo chown -R 1000:1000 ./data        # 数据目录（compose 用命名卷时可跳过）
sudo chmod -R a+rX /path/to/comics    # 漫画目录
```

也可以用 `user: "uid:gid"`（compose）或 `docker run --user` 换运行身份。
权限不符的典型表现：封面生成报 `EACCES`、进度保存失败、日志出现 `Permission denied`。

## 健康检查

镜像内置 `HEALTHCHECK`，探测 `GET /healthz`（不鉴权、不扫盘）：

```bash
curl -s http://127.0.0.1:3000/healthz
# {"ok":true,"version":"1.5.0","uptime":12,"scanReady":true,"online":false}
```

## 升级与备份

```bash
docker compose pull && docker compose up -d
```

数据都在 `DATA_DIR`（`comic-data` 卷）里，格式向后兼容，升级前备份一下即可：

```bash
docker run --rm -v comic-data:/d -v $PWD:/b alpine tar czf /b/data.tgz -C /d .
```

## 在线源（可插拔）

内置 `jm` 作为示例源，**默认关闭**：不设置 `ONLINE_SOURCE` 时在线模块完全关闭，纯本地使用。

启用后，前端「在线」页提供源切换器，搜索会跨所有已启用源聚合。图片经服务端代理还原（含反乱序、防盗链处理），并带 SSRF 防护与缓存。

新增一个源只需两步：在 `lib/sources/` 下实现统一接口的文件，再到 `lib/sources/sources.json` 清单里加一项。接口定义与示例见 [ONLINE_SOURCES.md](ONLINE_SOURCES.md)。

## 目录结构

```
server.js              Express 服务入口
lib/
  sources/              在线源：jm.js 示例实现、sources.json 源清单、index.js 注册表
  online-image.js       图片代理（SSRF 防护、下载、缓存、解码派发）
  scanner / cbz / epub / decrypt / thumbnail ...
  progress / auth / settings / jsonstore ...
public/                前端（index.html / app.js / reader.js / vendor/pdfjs ...）
```

## 开发

```bash
npm install
npm start            # 或 npm run dev（热重载）；默认 http://localhost:3000
```

需要 Node.js ≥ 20（`sharp` 走预编译二进制，无需本机编译）。

## 合规与免责声明

`jm` 在线源仅作为「可插拔在线源」的一个示例实现。

- 在线源的可用性依赖第三方站点，可能随时失效或变更；本项目不保证、不维护任何站点的可达性。
- 请遵守你所在国家或地区的法律法规，仅访问你有权访问的内容。
- 使用在线源产生的任何版权、合规责任由使用者自行承担。
- 在线功能默认关闭，不设置 `ONLINE_SOURCE` 即为纯本地使用。
