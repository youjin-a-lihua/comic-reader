# Comic Reader

> English version: [README.en.md](README.en.md)

自托管的漫画与小说阅读服务器。一个容器跑起来，浏览器、手机、平板都能读。

- 本地库：扫描 PDF / CBZ / CBR / EPUB，自动生成封面，记录阅读进度
- 加密 PDF：支持自动解密，口令在管理后台或环境变量配置
- EPUB 阅读器：目录、排版设置、批注与高亮、AI 章节总结（见 [ANNOTATIONS.md](ANNOTATIONS.md)）
- 多用户：账号登录、书架、收藏、继续阅读、阅读排行
- 可插拔在线源：搜索 / 在线阅读 / 下载入库，默认关闭（见 [ONLINE_SOURCES.md](ONLINE_SOURCES.md)）
- AstrBot 联动（可选）

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

## 更新记录

### 1.5.1（2026-10-25）

安全

- AstrBot 接口的内网判断此前写反，`192.168.x`/`127.0.0.1`/`::1`/Docker 网段等全部放行；现改为与图片代理同一套「先解析 DNS 再逐地址校验」的实现，并覆盖十进制 IP、IPv4-mapped 等形态
- AstrBot 的配置、指令、会话、附件接口收紧为管理员可用（配置是全局的，此前任意登录用户可覆盖）
- 登录限流不再信任客户端可伪造的 `X-Forwarded-For`（需要时设 `TRUST_PROXY=1` 显式开启）
- `users.json` 损坏或不可读时拒绝登录，不再把管理员权限交给第一个登录的人
- 用户名限定为字母、数字与 `._-@`（1–64 字符），并同步约束首跑建号
- 批注只能由创建者修改或删除
- 错误日志不再打印带 token 的完整 URL；启动日志不再打印 JWT 前缀
- 在线源的搜索排序、漫画 ID、章节 ID 改为编码后拼接
- 图片代理：连接固定为通过校验的那个 IP（防 DNS 重绑定）；缓存增加字节上限与 TTL

修复

- CBR 页面此前按 UTF-8 文本读取，二进制的每一页都是坏图；现按 Buffer 提取
- 在线「加载更多」改为追加结果，不再用第 2 页替换第 1 页
- 书库网格回收视口上方内容后，向上滚动会重建网格，不再留下永久空白
- 在线下载入库后书库立即刷新，此前最多 10 分钟看不到新文件
- 下载历史的上限开始生效（`update()` 忽略返回值导致此前无上限增长）
- 管理后台用户列表的用户名改走属性转义

### 1.5.0（2026-10-23）

新增

- 阅读时预加载相邻页：CBZ/CBR 预取后两页图片，PDF 预渲染下一页；更改缩放或旋转屏幕后自动失效
- `GET /healthz` 健康检查端点，镜像内置 Docker `HEALTHCHECK`
- GitHub Actions 自动构建 amd64 / arm64 镜像并发布到 GHCR
- docker-compose 补充 `TZ`、`DECRYPT_PASSWORD`，默认引用已发布的镜像

修复

- 部分 EPUB 打开后目录为空白：OPF manifest 解析此前依赖属性书写顺序，现按属性名解析
- 「自动解密」开关关闭后看门狗仍在运行，现尊重该开关，且只处理新增或改动的文件
- 删除漫画后兜底目录中的封面文件未被删除，长期使用会积累孤儿文件
- PDF 分段下载在客户端中断后未释放文件句柄，长时间阅读可能耗尽文件描述符
- 返回书架后立即打开另一本书时，阅读器可能被上一次的退出收尾隐藏

变更

- Docker 基础镜像换为 node:22-alpine，镜像体积从约 1.3GB 降到约 305MB
- 镜像内置 bsdtar；系统没有 unrar 时 CBR 自动改用 bsdtar 解压（此前容器内没有 unrar，CBR 无法阅读）
- 依赖安装改用 `npm ci`，构建结果可复现
- 书库接口的封面检查、扫描去重与 ETag 调整：库无变化时客户端不再重复下载整个书目

### 1.4.7（2026-10-01）

- 文件在应用之外被删除或改名后，阅读进度与收藏不再丢失，界面标记为「文件已不存在」
- 管理后台新增失效记录面板；删除漫画前可查看影响范围

### 1.4.6（2026-10-01）

- 修复中文等非 ASCII 用户名登录后书架等页面为空的问题（用户名进入 ETag 前先做哈希）

### 1.4.5（2026-09-30）

- 界面图标由字符改为内联 SVG，共替换 100 处，不新增文件与依赖

### 1.4.4（2026-09-30）

- 清理 README 与代码注释中的冗余内容

### 1.4.3（2026-09-29）

- 设置接口不再返回明文口令；口令输入框改用密码框；审计日志脱敏；新增「清除口令」

### 1.4.2（2026-09-29）

- 移除内置的默认解密口令，改为管理后台或 `DECRYPT_PASSWORD` 提供

### 1.4.1（2026-09-29）

- 精简代码注释；补充英文文档

### 1.4.0（2026-09-24）

- EPUB 批注 / 高亮：选中文字后四色高亮或写批注，按书存储、跨设备同步
- AI 章节总结
- 修复：翻页热区遮挡正文、无标签的漫画不可见、小说库 PDF 类型误判、EPUB 目录前缀匹配

### 1.3.0（2026-09-21）

- 操作审计日志（仅管理员可见）；在线漫画下载清单与下载历史
- 加密 PDF 检测改为只读文件尾部，不再把整本书读入内存
- 修复 CBZ/CBR 无法阅读、封面串档、设置不落盘等问题；图片代理 SSRF 加固
