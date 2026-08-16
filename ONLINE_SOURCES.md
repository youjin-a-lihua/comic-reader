# 在线模块技术文档（可插拔多源）

> 适用对象：想**部署**阅读器并开启在线漫画，或想**自己接入一个新站点**的开发者。
> 本地漫画库（扫描 PDF/CBZ/EPUB）请见主 `README.md`，本文只讲「在线源」部分。

---

## 0. 一句话总览

在线模块是一套**与具体站点解耦的可插拔架构**：

- 后端 `server.js` 只通过一个「源注册表」(`lib/sources`) 调用源，**永远不直接写站点协议**；
- 每个站点是一个实现**统一接口**的文件（参考 `lib/sources/jm.js`）；
- 仓库内置 `jm`（禁漫天堂）作为**示例源**，但**默认不启用**——是否开启、开启哪些，完全由部署者用环境变量 `ONLINE_SOURCE` 决定；
- 前端「在线」tab 会根据已启用源自动渲染**源切换器**，搜索会跨所有已启用源并发聚合。

---

## 1. 设计原则

| 原则 | 说明 |
|---|---|
| **默认关闭（opt-in）** | `ONLINE_SOURCE` 留空 = 不注册、不启用任何在线源。搜索/详情/图片代理全部返回「未启用」提示。**不设置即纯本地使用，不连接任何第三方站点。** |
| **可插拔** | 加一个新站点 = 在 `lib/sources/` 放一个实现统一接口的文件 + 在 `sources.json` 加一项。前端、后端、图片代理自动适配，**无需改 `server.js`**。 |
| **解耦** | 站点协议（鉴权、加解密、乱序还原、域名探测）全部封装在源文件内。源失效只改对应文件，不影响其它源。 |
| **服务端代理** | 图片由服务端拉取并还原后下发给前端，前端 `<img>` 只认 `/api/online/img?url=...`。站点防盗链、Referer、乱序对前端透明。 |

合规与免责见文末第 8 节。

---

## 2. 部署并开启在线源

### 2.1 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ONLINE_SOURCE` | 空（默认关闭） | 启用的在线源。取值见下。 |
| `PORT` | `3000` | 监听端口（`docker-compose.yml` 中映射为 `${PORT:-3000}:3000`，可改成 6767 等）。 |
| `DATA_DIR` | `/app/data` | 运行时数据（用户、JWT 密钥、书架）。**务必挂卷持久化**，否则重启丢管理员。 |
| `JWT_SECRET` | 空 | 留空则首次启动自动生成并写入 `DATA_DIR/.jwt-secret`，重启不失效；也可填 ≥32 字符固定串。 |

### 2.2 `ONLINE_SOURCE` 取值

| 取值 | 含义 |
|---|---|
| _（不设置 / 空）_ | 仅启用 `enabledByDefault:true` 的源。当前清单里没有任何源默认开启 → **全关**。 |
| `jm` | 仅启用 `jm`（禁漫天堂）。 |
| `jm,kavita` | 启用多个（逗号或空格分隔）。 |
| `all` | 启用 `sources.json` 清单里的**全部**源。 |

> 前端「在线」tab 会按 `/api/online/sources` 自动列出已启用源并提供切换器；搜索跨所有已启用源聚合。

### 2.3 Docker Compose 开启（推荐）

编辑 `docker-compose.yml` 的 `environment`，加一行：

```yaml
environment:
  PORT: 3000
  ONLINE_SOURCE: "jm"        # ← 加这一行开启禁漫天堂
  # JWT_SECRET: "你的>=32字符随机串"   # 可选，固定密钥
```

然后：

```bash
docker compose up -d --build
```

打开 `http://<服务器IP>:3000`，**首次用任意账号密码登录即自动成为管理员**。

### 2.4 直接 docker run 开启

```bash
docker build -t comic-reader .
docker run -d -p 3000:3000 \
  -e ONLINE_SOURCE=jm \
  -v $(pwd)/comics:/comics \
  -v comic-data:/app/data \
  --name comic-reader comic-reader
```

---

## 3. HTTP API 参考

> **鉴权**：所有 `/api/online/*` 路由都需要登录。`Authorization: Bearer <token>`。
> 登录流程：先用账号密码 `POST /api/login`（或前端登录页）拿到 JWT，后续请求带上。
> 首次登录的账号自动成为管理员。第三方脚本集成时，自行先登录取 token 再调用下文接口。

### `GET /api/online/sources`
返回当前已启用的源列表（前端渲染源切换器用）。
```json
{
  "enabled": true,
  "sources": [
    { "key": "jm", "name": "禁漫天堂", "description": "示例在线源，需手动启用" }
  ]
}
```

### `GET /api/online/status`
在线模块整体状态（前端据此决定是否展示「未启用」提示，无需先触发搜索）。
```json
{
  "enabled": true,
  "source": "jm",
  "available": [
    { "key": "jm", "name": "禁漫天堂", "description": "...", "enabled": true }
  ]
}
```

### `GET /api/online/search`
跨**所有已启用源**并发搜索并合并结果；每条结果带 `_source` 标记以便后续 `album`/`chapter` 路由。
| 参数 | 必填 | 说明 |
|---|---|---|
| `q` | 是 | 关键词 |
| `order` | 否 | 排序，默认 `mr`（最新）。透传给源 |
| `page` | 否 | 页码，默认 1 |

```json
{
  "total": 12,
  "maxPage": 1,
  "comics": [
    { "id": "12345", "title": "...", "author": "...", "cover": "https://...", "tags": [...], "description": "...", "_source": "jm" }
  ]
}
```
> 注意：搜索是**聚合所有已启用源**，接口不接收 `source` 参数；多源结果通过 `_source` 区分归属。

### `GET /api/online/album/:id`
获取作品详情（章节列表、作者、标签、相关推荐）。
| 参数 | 必填 | 说明 |
|---|---|---|
| `source` | 否 | 指定源 key；缺省用首个启用源。多源时务必带上搜索结果里的 `_source`。 |

```json
{
  "id": "12345",
  "title": "...",
  "author": "...",
  "cover": "https://...",
  "description": "...",
  "likes": 123,
  "tags": { "author": [...], "works": [...], "tags": [...] },
  "chapters": [ { "id": "67890", "title": "第1話" } ],
  "related": [ ... ],
  "_source": "jm"
}
```

### `GET /api/online/chapter/:id`
获取某章节的图片 URL 列表（原始 URL，前端再经 `/api/online/img` 代理显示）。
| 参数 | 必填 | 说明 |
|---|---|---|
| `source` | 否 | 同 `album`。 |

```json
{ "epId": "67890", "images": [ "https://cdn.../media/photos/67890/001.webp", ... ] }
```

### `GET /api/online/img`
**图片代理**：服务端拉取原图 → 调用对应源的 `decodeImage` 还原（反乱序/解密）→ 返回可显示图片。前端 `<img src="/api/online/img?url=<原图URL>">` 即可。
| 参数 | 必填 | 说明 |
|---|---|---|
| `url` | 是 | 原始图片 URL（需为 http/https 域名，**禁止 IP 直连 / localhost**，见第 5 节） |

成功：返回图片字节（`Content-Type: image/webp`，内容图统一 webp；封面保持原格式），并带 `Cache-Control: public, max-age=86400`。
失败：`400/502` + `{ "error": "..." }`。

---

## 4. 前端源切换器行为

- 进入「在线」tab 时，前端请求 `/api/online/sources` 拿到已启用源列表。
- 若 `enabled=false`（未设置 `ONLINE_SOURCE`）：展示「在线模块未启用」提示，不显示切换器。
- 若启用 1 个源：直接展示该源，无切换器。
- 若启用 ≥2 个源：顶部出现源切换下拉框，切换后重新拉取该源的搜索/列表。
- 搜索结果来自所有启用源的聚合；点开作品时，前端把结果里的 `_source` 透传给 `album`/`chapter`，确保路由到正确源。

---

## 5. 图片代理与 SSRF 防护（`lib/online-image.js`）

请求链路：

```
前端 <img src="/api/online/img?url=U">
  → SSRF 校验：仅允许 http/https 域名，拒绝 IP 直连 / localhost
  → findDecoder(U)：遍历已启用源的 parseImageUrl，认得该 URL 的源即解码者；都不认则用首个启用源
  → 服务端带 Referer/UA 拉取原图（绕防盗链）
  → 调用源的 decodeImage(buffer, parsed) 还原
  → LRU 缓存（上限 200 张）→ 返回图片
```

**SSRF 防护要点**（接入自托管源时需注意）：

- 协议必须是 `http:` / `https:`；
- **不允许 IP 直连**（如 `http://1.2.3.4/...` 会被拒），必须是域名；
- 不允许 `localhost` / `*.localhost`。

> 因此：若你接入的源图片走 CDN 域名，正常可用；若想用 IP 形式的内网源，会被代理拦截——这是故意的安全设计。

---

## 6. 如何新增一个源（插件开发指南）

### 6.1 实现统一接口

在 `lib/sources/` 下新建 `mysite.js`，导出以下成员（参考 `lib/sources/jm.js`）：

```js
'use strict';
// 可选依赖，按需引入
const https = require('https');

module.exports = {
  // —— 元信息（也可只在 sources.json 写，这里作为兜底）——
  name: 'mysite',            // 源 key（与清单一致）
  label: '我的站点',          // 展示名

  // 搜索：返回标准结构
  //   -> { total, maxPage, comics:[{ id, title, author, cover, tags, description }] }
  async search(keyword, order, page) { /* ... */ },

  // 详情：返回标准结构（chapters 必填）
  //   -> { id, title, author, cover, description, likes, tags, chapters:[{ id, title }], related }
  async album(id) { /* ... */ },

  // 章节图片列表：返回完整图片 URL 数组
  //   -> { epId, images:[ url1, url2, ... ] }
  async chapter(epId) { /* ... */ },

  // 可选：封面/图片 URL 构造器（前端/代理可借用）
  getCoverUrl(id) { /* ... */ },
  getImageUrl(epId, name) { /* ... */ },

  // 图片还原（核心）：把服务端拉到的「原始」图还原为可显示图。
  //   parsed 由 parseImageUrl 产出；无需处理则返回原 buffer。
  //   内容图建议统一输出 webp（代理会据此设 Content-Type）。
  async decodeImage(buffer, parsed) { return buffer; },

  // 图片 URL 识别：判断是否「本源的图片」。
  //   返回 { kind:'photo'|'cover', epId?, pictureName?, isGif? } 或 null。
  //   图片代理用它自动路由解码者——返回的字段会原样传给 decodeImage。
  parseImageUrl(u) {
    const m = /^\/media\/photos\/(\d+)\/([^/]+)$/.exec(u.pathname);
    if (!m) return null;
    return { kind: 'photo', epId: m[1], pictureName: m[2].replace(/\.[^.]+$/, ''), isGif: /\.gif$/i.test(m[2]) };
  },
};
```

**各方法返回结构约定（前端依赖，请勿随意改字段名）：**

| 方法 | 返回 | 关键字段 |
|---|---|---|
| `search` | `{ total, maxPage, comics:[...] }` | `comics[].id` / `title` / `author` / `cover` / `tags` / `description` |
| `album` | 对象 | `id` / `title` / `author` / `cover` / `description` / `likes` / `tags` / `chapters:[{id,title}]` / `related` |
| `chapter` | `{ epId, images:[...] }` | `images` 为**完整 URL** 数组 |
| `decodeImage` | `Buffer` | 还原后的图片字节 |
| `parseImageUrl` | 对象 / `null` | `kind` / `epId` / `pictureName` / `isGif` |

### 6.2 登记到清单

编辑 `lib/sources/sources.json`，加一项：

```json
[
  { "key": "jm", "name": "禁漫天堂", "file": "jm.js", "enabledByDefault": false, "description": "示例在线源，需手动启用" },
  { "key": "mysite", "name": "我的站点", "file": "mysite.js", "enabledByDefault": false, "description": "自托管示例源" }
]
```

字段：

| 字段 | 说明 |
|---|---|
| `key` | 源唯一标识（小写），前端 `?source=` 用它 |
| `name` | 展示名（切换器里显示） |
| `file` | 实现文件名（在 `lib/sources/` 下） |
| `enabledByDefault` | 是否在不设 `ONLINE_SOURCE` 时默认启用。**默认请保持 `false`**（合规：仓库不替用户默认打开任何第三方站） |
| `description` | 切换器/状态接口里的说明文字 |

### 6.3 启用与调试

1. 部署时设置 `ONLINE_SOURCE=jm,mysite`（或 `all`）。
2. 重启服务。
3. 验证：`GET /api/online/sources` 应列出 `mysite`；`GET /api/online/status` 的 `available` 里 `mysite.enabled=true`。
4. 调试技巧：
   - 源文件加载失败会在服务端日志打印 `[sources] 加载源 <key> 失败：...`，检查 `file` 路径与导出。
   - 图片显示异常：确认 `parseImageUrl` 能识别你的图片 URL、`decodeImage` 返回合理字节。
   - 图片代理若返回「当前在线源不支持此图片 URL」，说明 `findDecoder` 没匹配到——检查 `parseImageUrl` 与 `enabledSet`。

---

## 7. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `GET /api/online/sources` 等返回 `401 未登录` | 正常——接口需 JWT。先登录拿 token 再带 `Authorization: Bearer`。 |
| 搜索/详情返回 `403 在线漫画模块未启用` | 没设 `ONLINE_SOURCE` 或值不在清单里。设置 `ONLINE_SOURCE=jm` 并**重启**。 |
| 前端「在线」tab 显示「未启用」 | 同上，环境变量未生效或未重启。 |
| 图片空白 / `502 图片获取失败` | 原图拉取失败（站点防盗链/域名失效/超时）。看服务端 `[online/img]` 日志。 |
| `400 不允许 IP 直连` / `主机无效` | 图片 URL 用了 IP 或 localhost，被 SSRF 防护拦截（第 5 节）。改用域名。 |
| `jm` 搜索/图片全失败 | jm API 域名会变动。编辑 `lib/sources/jm.js` 的 `API_DOMAINS` 候选列表，补充当前可用域名后重建镜像。 |
| 反乱序图片仍错乱 | `jm.js` 的 `computeScrambleNum` 基于 epId 计算扰序块数；若 jm 改了算法需同步更新（已用像素级验证）。 |

---

## 8. 合规与免责声明

本仓库是一个**通用漫画阅读器**，`jm` 在线源仅作为「可插拔在线源」的**示例实现**：

- 在线源的可用性依赖第三方站点，可能随时失效或变更；本项目**不保证、不维护**任何站点的可达性。
- 请**遵守你所在国家或地区的法律法规**，仅访问你有权访问的内容。
- 使用在线源产生的任何版权、合规责任由使用者自行承担，本项目及作者不承担任何责任。
- 在线功能**默认关闭**：只需不设置 `ONLINE_SOURCE`（缺省即关闭），即可纯本地使用，不连接任何第三方站点；需要时才显式设置 `ONLINE_SOURCE=jm` 开启。
- 本地 JM 下载后处理（需宿主机 `python3` + `jmcomic` + AstrBot）不在本仓库范围内，可作为你自己的私有插件扩展，不随主仓库发布。

---

## 附：关键文件索引

| 文件 | 职责 |
|---|---|
| `lib/sources/index.js` | 源注册表：读 `sources.json` 自动加载、解析 `ONLINE_SOURCE`、导出 `getEnabled/getSource/findDecoder/...` |
| `lib/sources/sources.json` | 源清单（key/name/file/enabledByDefault/description） |
| `lib/sources/jm.js` | `jm` 示例源完整实现（鉴权、AES 解密、域名探测、图片反乱序、URL 解析） |
| `lib/online-image.js` | 通用图片代理（SSRF 防护、下载、LRU 缓存、按 `parseImageUrl` 派发 `decodeImage`） |
| `server.js`（957 行起） | 在线路由：`/api/online/{sources,status,search,album,chapter,img}` |
| `.env.example` / `docker-compose.yml` | `ONLINE_SOURCE` 等环境变量示例 |
