# Comic Reader · 通用漫画阅读器

> English version: [README.en.md](README.en.md)

一个自托管的漫画/小说阅读器，带两种内容来源：

- **本地库**：扫描服务器上的 PDF / CBZ / CBR / EPUB，自动生成封面、记录阅读进度、收藏与点赞。
- **在线源（可插拔）**：内置 `jm`（禁漫天堂）示例源，支持搜索 → 详情 → 在线阅读，图片经服务端代理还原（含反乱序、绕防盗链），前端无需关心站点协议。

自带账号登录（JWT）、书架、进度同步、AstrBot 联动（可选）。

---

## ✨ 功能

- 📚 本地漫画库：PDF / CBZ / CBR（含加密 PDF 解密）、EPUB
- 🔍 搜索、排行榜、全库浏览、继续阅读
- ⭐ 收藏、点赞、书架、多用户
- ✎ **批注 / 高亮**：EPUB 选中文字 → 四色高亮或写批注，服务端按书存储、跨设备同步；侧栏「批注」页签可跳转 / 修改 / 删除
- 🤖 **AI 章节总结**：一键生成当前 EPUB 章节摘要（详见 [ANNOTATIONS.md](ANNOTATIONS.md)）
- 🌐 **在线源**：搜索 / 详情 / 章节 / 在线阅读，图片服务端代理还原
- 🔌 **在线源可插拔**：加一个新站点只需在 `lib/sources/` 放一个实现统一接口的文件
- 🤖 可选 AstrBot 联动：在弹窗里填 AstrBot 地址/账号，直接下发 `/jm` 等指令并轮询结果

---

## 🚀 一键部署（Docker Compose，推荐）

> 朋友拿到仓库后，三步即可跑起来：

```bash
git clone <本仓库地址> comic-reader
cd comic-reader

# 准备漫画目录（把你的漫画放进去，或改 docker-compose.yml 的挂载路径）
mkdir -p comics

# 启动
docker compose up -d --build
```

打开 `http://<你的服务器IP>:3000`，**首次用任意账号密码登录即自动成为管理员**
（之后可在「我的」里添加其他用户）。

数据（用户、书架、JWT 密钥、AstrBot 配置）持久化在名为 `comic-data` 的卷里，重启不丢。

### 不用 Compose，直接 docker run

```bash
docker build -t comic-reader .
docker run -d -p 3000:3000 \
  -v $(pwd)/comics:/comics \
  -v comic-data:/app/data \
  --name comic-reader comic-reader
```

---

## ⚙️ 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `COMICS_DIR` | `/comics` | 本地漫画根目录（挂载卷） |
| `DATA_DIR` | `/app/data` | 运行时数据目录（挂卷持久化） |
| `JWT_SECRET` | 空 | 留空则首次启动自动生成并写入 `DATA_DIR/.jwt-secret`；也可填 ≥32 字符固定串 |
| `ONLINE_SOURCE` | 空（默认关闭） | 启用的在线源；留空则**不启用任何在线源**。可设为单个（`jm`）、逗号/空格分隔的多个（`jm,kavita`），或 `all` 启用清单里全部（见 `lib/sources/sources.json`）。前端「在线」tab 会自动列出已启用源并提供切换器，搜索会跨所有已启用源聚合结果。 |
| `NOVEL_DIR` | 空 | 小说目录绝对路径；不设则不显示「小说」库 |
| `DECRYPT_PASSWORD` | 空 | 加密 PDF 的打开密码。也可在管理后台「加密密码」处填写（存进 `DATA_DIR/settings.json`，**优先于**本变量）。两处都为空则不解密。口令**不会回传前端**（页面只显示「已配置／未配置」），审计日志里也被脱敏为 `***` |

---

## 🧩 在线源插拔架构

> **默认关闭**：仓库内置 `jm`（禁漫天堂）作为示例源，但**默认不注册、不启用**。部署者需在环境变量中显式设置 `ONLINE_SOURCE=jm` 才会开启；留空则在线模块完全关闭（搜索/详情/图片代理均返回「未启用」提示）。这是「可插拔源」的设计——仓库不默认打开任何第三方站点，是否启用、启用哪些完全由你决定。

在线模块与具体站点解耦。`server.js` 只通过 `lib/sources` 注册表调用源，站点协议封装在各源文件里，**新增/启用源只改清单，无需改 `server.js`**。

**源清单**（`lib/sources/sources.json`，列出所有可用源 + 元信息）：

```json
[
  { "key": "jm", "name": "禁漫天堂", "file": "jm.js", "enabledByDefault": false, "description": "示例在线源，需手动启用" }
]
```

**启用哪些源**由 `ONLINE_SOURCE` 决定：不设置（仅 `enabledByDefault:true` 的源，当前无）→ 单个 `jm` → 多个 `jm,kavita` → `all` 启用清单全部。前端「在线」tab 会据 `/api/online/sources` 自动列出已启用源并提供切换器，搜索时跨所有已启用源并发聚合结果。

**统一接口**（参考 `lib/sources/jm.js`）：

```js
module.exports = {
  name: 'jm',                       // 源标识
  label: '禁漫天堂',                 // 展示名
  search(keyword, order, page),     // -> { total, maxPage, comics:[{id,title,author,cover,tags,description}] }
  album(id),                        // -> { id, title, author, cover, description, likes, tags, chapters:[{id,title}], related }
  chapter(epId),                    // -> { epId, images:[url...] }
  getCoverUrl(id), getImageUrl(epId, name),   // 可选
  decodeImage(buffer, parsed),      // 把拉到的原始图还原为可显示图；无操作则返回原 buffer
  parseImageUrl(u),                 // 解析该源图片 URL -> { kind, epId?, pictureName?, isGif } 或 null（图片代理据此自动路由解码者）
};
```

**新增一个源**：在 `lib/sources/` 下新建文件实现上述接口，再到 `lib/sources/sources.json` 加一项（`key`/`name`/`file`/`enabledByDefault`）即可。前端、后端、图片代理都会自动适配，无需改动其他代码。

图片代理（`lib/online-image.js`）负责 SSRF 防护、下载、LRU 缓存；多源时按各启用源的 `parseImageUrl` 识别图片归属并派发对应源的 `decodeImage`。

---

## 📁 目录结构

```
server.js              Express 服务入口
lib/
  sources/             ★ 在线源（可插拔、多源）：jm.js 为示例实现，sources.json 为源清单，index.js 为注册表（按清单自动加载）
  online-image.js      通用图片代理（SSRF + 下载 + 缓存 + 派发解码）
  scanner/cbz/epub/... 本地库扫描与解析
  progress/auth/...    进度、账号、书架等
public/                前端（index.html / app.js / reader.js / vendor/pdfjs ...）
```

---

## ⚠️ 合规与免责声明

本仓库是一个**通用漫画阅读器**，`jm` 在线源仅作为「可插拔在线源」的一个**示例实现**。

- 在线源的可用性依赖第三方站点，可能随时失效或变更；本项目不保证、不维护任何站点的可达性。
- 请**遵守你所在国家或地区的法律法规**，仅访问你有权访问的内容。
- 使用在线源产生的任何版权、合规责任由使用者自行承担，本项目及作者不承担任何责任。
- 在线功能**默认关闭**：只需不设置 `ONLINE_SOURCE`（缺省即关闭），即可纯本地使用，不连接任何第三方站点；需要时才显式设置 `ONLINE_SOURCE=jm` 开启。
- 本地 JM 下载后处理（需要宿主机 `python3` + `jmcomic` + AstrBot）不在本仓库范围内，可作为你自己的私有插件扩展，不随主仓库发布。

---

## 🛠 开发

```bash
npm install
npm start            # 或 npm run dev（监听热重载）
# 默认 http://localhost:3000
```

需要 Node.js ≥ 20（`sharp` 用于图片还原，安装时走预编译二进制，无需本机编译）。

---

## 📦 更新记录

### v1.4.3 (2026-09-29)

**安全**
- 🔒 把口令处理的残余缝隙堵上：`GET /api/admin/settings` **不再回传明文口令**（改为只返回 `hasDecryptPassword`）；
  设置项输入框改为 `type="password"`；**审计日志不再记录口令原文**（脱敏为 `***`）；
  新增「清除口令」按钮，此前一旦填写就再也清不掉

### v1.4.2 (2026-09-29)

**安全**
- 🔐 **移除硬编码的默认解密密码**：`lib/settings.js` 里内置的明文默认值已删除，加密 PDF 的密码改为从管理后台或 `DECRYPT_PASSWORD` 环境变量读取；两处都为空时自动解密保持空闲，不再拿空密码去试

### v1.4.1 (2026-09-29)

**整理 / 文档**
- 🧹 精简全库注释：去掉带日期的改动清单、复述代码的注释与装饰性分隔线，注释密度 9.8% → 0.8%；保留下来的说明改为英文
- 📄 文档补齐英文版：[README.en.md](README.en.md) · [ANNOTATIONS.en.md](ANNOTATIONS.en.md) · [ONLINE_SOURCES.en.md](ONLINE_SOURCES.en.md)

### v1.4.0 (2026-09-24)

**新增 · 批注 / 笔记**
- ✎ **选中文字 → 高亮 / 写批注**：阅读 EPUB 时拖选正文，弹出四色色板（黄 / 绿 / 蓝 / 粉）或「写批注」；批注按书存在服务端，**刷新页面、换设备都在**
- 📑 顶栏「✎」按钮（带数字徽标）→ 侧栏切到「批注」页签：列出全书批注，点原文跳章定位高亮，点高亮块可改可删
- 🤖 **AI 章节总结**：顶栏「AI」按钮生成当前章节摘要（前端带缓存）
- 🔌 新增接口：`GET/POST /api/comic/:id/annotations`、`PATCH/DELETE /api/comic/:id/annotations/:aid`、`GET /api/comic/:id/summary[/:chapter]`
  - 存储：`DATA_DIR/annotations/<comicId>.json`；删除书籍时一并清理
  - 细节见 [ANNOTATIONS.md](ANNOTATIONS.md)

**修复**
- 🖱 修复 `.epub-tap-zone`（翻页热区）`width:25%` + `z-index:5` 浮在正文之上，导致**左右各 25% 的正文无法选中**——文字一按就被当成翻页。
  改为自适应宽度 `max(10%, calc((100% - 800px) / 2))`（宽屏落在正文列之外，窄屏最多占 10%）；翻页仍可用底栏 ◀ ▶
- 🗂 修复**无标签的书在「漫画」tab 完全不可见**：原分组只收录有标签的书，而「全库兜底」在有大库的实例上永不触发（本库实测 170+ 本受影响）→ 现归入「未分类」组
- 📚 修复**放进「小说」库的 PDF 仍被判为漫画**：sidecar 元数据显式声明 `type` 时优先采用，其次才按扩展名推断。
  注意 `scanner` 有同步 / 异步两条扫描路径，**只改一条等于没改**
- 📖 修复 EPUB 目录（TOC）在 `spine.href` 带目录前缀（`OEBPS/xxx.xhtml`）时匹配不到章节标题

### v1.3.0 (2026-09-21)

**性能（关键修复）**
- 🚀 **修复看门狗导致 SSD 被无效读取**：`lib/decrypt.js` 原先为判断「PDF 是否加密」而把**整本文件**读入内存（全库约 1290 本、均 26 MB），每 30 分钟一轮 →
  实测 `/vol3` **日均读 1.6 TB**、`node` 进程平均 CPU **6.0%**。
  现改为**只读文件尾部 256 KB 窗口**判定（PDF 的 trailer 字典位于文件末尾），并保留安全阀：窗口内看不到 `%%EOF` 时退回原有完整流程。
  - 效果：日读 **1.6 TB → 6.4 GB（降 99.6%）**，稳态 CPU **6.0% → 0.2%**
  - 回归：加密 PDF 仍能被识别解密；明文文件字节零改动

**新增**
- 🧾 **操作日志（仅管理员可见）**：记录账号 / IP / 时间 / 操作 / 结果；JSONL 追加存储 + 500 条内存环形缓冲 + 5 MB 自动轮转
- 📥 **下载清单**：在线漫画长按多选加入清单，累积后统一整本下载（前端串行，避免触发后端并发上限）
- 📜 **下载历史**：任务结果持久化（`downloads.json`），重启不丢

**体验修复**
- 🎨 登录页 / 管理后台统一到主界面设计语言（此前各自一套独立内联样式）
- ↩️ 修复在线详情页**缺少返回键**
- 📐 修复进入详情页**滚动位置未重置**（需上滑才能看到「开始阅读」）及由此引起的转场动画错位
- 🔁 修复阅读器左上角返回键重复

**健壮性 / 安全**
- 修复设置保存**不落盘**（`jsonstore` 缺 dirty 标记，自动解密等开关重启即失效）
- Express 4 未捕获 async 异常导致**请求永久挂起** → 统一注入 Promise 包装器
- `users.json` 改原子写（原裸 `writeFileSync` 崩溃截断会被误判为首次运行而**重建管理员、丢失全部账号**）
- 修复 CBZ/CBR 翻页接口漏 `await` 导致**压缩包漫画无法阅读**
- 图片代理 **SSRF 加固**：改为 DNS 解析后按 IP 段判定（覆盖 IPv6 / IPv4-mapped / 十进制 IP / 域名指向内网），并加 20 MB 响应体上限与 CRLF 注入防护
- 封面缓存键改为「文件绝对路径 hash」，避免不同漫画**封面串档**
