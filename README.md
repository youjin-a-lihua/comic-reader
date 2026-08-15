# Comic Reader · 通用漫画阅读器

一个自托管的漫画/小说阅读器，带两种内容来源：

- **本地库**：扫描服务器上的 PDF / CBZ / CBR / EPUB，自动生成封面、记录阅读进度、收藏与点赞。
- **在线源（可插拔）**：内置 `jm`（禁漫天堂）示例源，支持搜索 → 详情 → 在线阅读，图片经服务端代理还原（含反乱序、绕防盗链），前端无需关心站点协议。

自带账号登录（JWT）、书架、进度同步、AstrBot 联动（可选）。

---

## ✨ 功能

- 📚 本地漫画库：PDF / CBZ / CBR（含加密 PDF 解密）、EPUB
- 🔍 搜索、排行榜、全库浏览、继续阅读
- ⭐ 收藏、点赞、书架、多用户
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
| `ONLINE_SOURCE` | 空（默认关闭） | 当前启用的在线源；留空则**不启用任何在线源**，设为 `jm` 才开启示例源（见 `lib/sources/`） |
| `NOVEL_DIR` | 空 | 小说目录绝对路径；不设则不显示「小说」库 |

---

## 🧩 在线源插拔架构

> **默认关闭**：仓库内置 `jm`（禁漫天堂）作为示例源，但**默认不注册、不启用**。部署者需在环境变量中显式设置 `ONLINE_SOURCE=jm` 才会开启；留空则在线模块完全关闭（搜索/详情/图片代理均返回「未启用」提示）。这是「可插拔源」的设计——仓库不默认打开任何第三方站点，是否启用、启用哪一个完全由你决定。

在线模块与具体站点解耦。`server.js` 只通过 `lib/sources` 注册表调用当前源，站点协议封装在各源文件里。

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
  parseImageUrl(u),                 // 解析该源图片 URL -> { kind, epId?, pictureName?, isGif } 或 null
};
```

**新增一个源**：在 `lib/sources/` 下新建文件实现上述接口，再到 `lib/sources/index.js` 的 `registerSource('xxx', require('./xxx'))` 注册即可，无需改动 `server.js`。前端通过 `ONLINE_SOURCE=xxx` 切换。

图片代理（`lib/online-image.js`）负责 SSRF 防护、下载、LRU 缓存，并把解码派发给当前源的 `decodeImage`。

---

## 📁 目录结构

```
server.js              Express 服务入口
lib/
  sources/             ★ 在线源（可插拔）：jm.js 为示例实现，index.js 为注册表
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
