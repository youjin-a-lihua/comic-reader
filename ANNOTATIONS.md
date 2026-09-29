# 阅读器「批注 / 笔记」+「AI 章节总结」—— 功能说明

> 起于 v1.4.0（2026-09-24）。适用于 EPUB 阅读模式。

## 一、做了什么

在阅读器里加上了**「选中文字 → 高亮 / 写批注」**能力（仿纸质书圈画），
附带 **AI 章节总结**，并顺带修掉一个真实缺陷（翻页热区挡住文字选择）。

## 二、用户怎么用

1. 打开任意 EPUB
2. 阅读时**用鼠标 / 手指拖选正文文字**
3. 弹出小工具条：**四个颜色圆点**（黄 / 绿 / 蓝 / 粉，点一下即高亮）或 **「写批注」**
4. 选「写批注」→ 弹出输入框（上方显示所选原文，可留空仅高亮）→ 保存
5. 顶栏「✎」按钮（带数字徽标）→ 侧栏切到「批注」页签 → 列出全书批注
   - 点条目原文 → 跳到该章节并定位高亮
   - 点高亮块 → 可修改批注内容
   - 点 ✕ → 删除
6. 顶栏「AI」按钮 → 生成当前章节的摘要

批注存在服务端（按书分文件），**刷新页面、换设备都在**。

## 三、改了哪些文件

| 文件 | 改动 |
|---|---|
| `server.js` | 新增批注存储 `annotationsDir` / `annotationsStore` + 4 个路由 + 章节总结路由；`deleteComicFully` 增批注清理 |
| `public/js/reader.js` | 顶栏批注 / AI 按钮、侧栏批注页签、浮动工具条、编辑框、选区 / 高亮 / 列表 / 跳转 / 删除逻辑 |
| `public/js/api.js` | `ComicAPI` 增 `getAnnotations` / `addAnnotation` / `updateAnnotation` / `deleteAnnotation` |
| `public/css/reader.css` | 批注全部样式；修 `.epub-tap-zone` 宽度 |
| `public/index.html` | 资源版本号 → `?v=20260924d` |
| `lib/epub.js` | TOC 兼容 `spine.href` 带目录前缀（`OEBPS/xxx.xhtml`） |

> ⚠️ **部署注意**：在 fnOS 实例上 `reader.css` 与 `index.html` 走**宿主挂载**
> （`/vol2/@appdata/fn-comic-reader/`），而 `server.js` / `reader.js` / `api.js`
> 位于**容器可写层**——**容器重建即丢失**，重建后需从本仓库重新投放。

### 接口

```
GET    /api/comic/:id/annotations            列出本书批注
POST   /api/comic/:id/annotations            新建 {chapter,text,note,color,occur}
PATCH  /api/comic/:id/annotations/:aid       改 note / color
DELETE /api/comic/:id/annotations/:aid       删除
GET    /api/comic/:id/summary/:chapter       AI 章节总结
```

存储：`DATA_DIR/annotations/<comicId>.json`（`DATA_DIR` 默认 `/app/data`）

## 四、顺带修掉的缺陷

`.epub-tap-zone`（翻页热区）原本 `width:25%` + `z-index:5` 浮在 iframe 之上，
**左右各 25% 的正文根本选不中**（一按就被当成翻页）。
已改为自适应宽度 `max(10%, calc((100% - 800px) / 2))` —— 宽屏时热区落在正文列之外，
窄屏时最多占 10%。翻页仍可用底栏 ◀ ▶ 按钮。

## 五、验证（真实浏览器端到端）

用本地 Chrome（headless）+ CDP **真实鼠标拖选**跑完整链路，16 步全绿：

| 步骤 | 结果 |
|---|---|
| 登录 / 打开 EPUB / iframe 就绪 / 批注按钮 | ✓ |
| 真实拖选（贴正文左边缘，x=184） | `SEL[1949年]` ✓ |
| 浮动工具条弹出 | ✓ |
| 提交批注 → 服务端存储 | `STORED:1` ✓ |
| iframe 内 `<mark>` 高亮 + 徽标 | `MARKS:1 BADGE:1` ✓ |
| 侧栏批注列表 | 「第3章 / 1949年 / E2E测试批注」✓ |
| **刷新页面后重开 → 高亮持久化** | `MARKS:1 title:E2E测试批注` ✓ |
| 列表项点击跳转 | ✓ |
| 清理测试数据 | `CLEANED:0` ✓ |

## 六、已知限制

- 高亮锚定用「章节 + 原文 + 第几次出现」定位，**若同一段文字被改动则可能失配**（静态书无影响）。
- 跨段落的大范围选择会被截断为段落内匹配（避免破坏段落结构）。
- AI 章节总结依赖部署实例上已配置的模型服务；未配置时按钮会报错。
