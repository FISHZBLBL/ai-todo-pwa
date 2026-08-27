# AI Todo PWA

一个个人使用、移动端优先、离线优先的 AI 辅助 Todo / Inbox PWA。它专注于一条短路径：快速记录 → 可选 AI 拆分与日期理解 → 用户确认 → 本地立即保存 → 后台同步与提醒。

## 已实现

- 快速添加、编辑、全局置顶、完成/恢复、软删除和 5 秒 Undo
- 今天/明天/未来/日期范围/无日期分组，明确时间优先排序，轻量过期提示
- AI Inbox、Web Speech API、300ms 草稿自动保存、失败重试和确认预览
- 日期与时间分离；模糊时段不伪造时间；下周/周末保存为范围
- URL 识别、全局搜索（任务、已完成、草稿、备注、URL）
- IndexedDB 主存储、离线创建、同步队列、LWW、删除 tombstone、30 天清理能力
- 单项/多选明确时间任务 ICS、版本化 JSON 导入导出与迁移入口
- 单用户密码哈希登录、JWT、鉴权、限流、AI Provider 抽象和 Zod 校验
- 多设备 Web Push 订阅、08:00 汇总和明确时间准点提醒调度入口
- PWA manifest、自定义 Service Worker、App Shell 缓存、iPhone Safe Area
- GitHub Actions 测试门禁与 Pages 部署；腾讯云 SCF 配置

## 技术栈

- 前端：Vue 3、Composition API、Pinia、TypeScript、Vite
- 本地数据：IndexedDB（`idb`）
- PWA：`vite-plugin-pwa`、Workbox
- 后端：Node.js、Express 5、Zod、bcrypt、JWT、Web Push、CloudBase JS SDK
- 测试：Vitest、fake-indexeddb、jsdom

## 项目结构

```text
src/
  components/       通用交互组件、任务行、编辑面板
  composables/      Web Speech 等浏览器能力
  repositories/    Task / Draft Repository
  services/         鉴权和 API 客户端
  storage/          IndexedDB schema 和 migration 入口
  stores/           Pinia 任务状态与操作
  sync/             离线同步队列和自动重连
  types/            数据模型
  utils/            日期、ICS、JSON 导入导出
  views/            AI Inbox、搜索、历史、设置、登录
  sw.ts             离线缓存、Push、通知点击
server/
  ai/               Provider、system prompt、输出 schema
  auth.ts           single-user authentication
  storage.ts        云端 LWW 存储适配器
  push.ts           汇总和明确时间通知
  index.ts          API 路由、鉴权与限流
tests/              日期、AI schema、Storage、Sync、Import/Export
```

## 本地运行

要求 Node.js 20+。

```bash
pnpm install
cp .env.example .env.local
pnpm run dev
```

另一个终端启动 API：

```bash
pnpm run dev:server
```

本地不设置 `VITE_API_URL` 时，前端使用 Vite 的 `/api` 代理并允许离线本地模式；生产构建设置 `VITE_API_URL` 后会启用登录门。

## 环境变量

完整模板见 [`.env.example`](./.env.example)。敏感变量只放在后端：

| 变量 | 用途 |
| --- | --- |
| `PASSWORD_HASH` | bcrypt 密码哈希，禁止明文 |
| `JWT_SECRET` | 至少 24 字符的随机签名密钥 |
| `AI_PROVIDER` | Provider 名称，仅用于状态和切换 |
| `AI_API_KEY` | AI 后端密钥，绝不使用 `VITE_` 前缀 |
| `AI_BASE_URL` / `AI_MODEL` | OpenAI-compatible 服务地址和模型 |
| `STORAGE_ADAPTER` | `file`（本地/CFS）或 `cloudbase`（生产推荐） |
| `DATA_FILE` | `file` Adapter 的开发文件或 CFS 持久路径 |
| `CLOUDBASE_ENV_ID` | CloudBase 环境 ID；使用 CloudBase Adapter 时必填 |
| `CLOUDBASE_REGION` | CloudBase 区域，默认 `ap-shanghai` |
| `CLOUDBASE_COLLECTION` | 状态集合，默认 `ai_todo_state` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web Push VAPID 密钥对 |
| `CRON_SECRET` | 定时调度端点鉴权 |
| `APP_TIMEZONE` | 服务端提醒计算时区，默认 `Asia/Shanghai` |
| `VITE_API_URL` | 公开 API 根地址，如 `https://api.example.com/api` |
| `VITE_VAPID_PUBLIC_KEY` | 可公开的 VAPID public key |

生成密码哈希和 VAPID 密钥：

```bash
node -e "import('bcryptjs').then(async b => console.log(await b.hash(process.argv[1], 12)))" "你的密码"
pnpm exec web-push generate-vapid-keys
```

不要把命令输出提交到 Git。`.env`、`.env.local` 和 `data/` 已被忽略。

## AI Provider 配置

业务层只依赖 `AIProvider` 接口。默认实现兼容 OpenAI 风格的 `/v1/chat/completions` 和 JSON object response format，可配置 DeepSeek 或其他兼容服务：

```env
AI_PROVIDER=deepseek
AI_BASE_URL=https://api.deepseek.com
AI_MODEL=deepseek-chat
AI_API_KEY=在云函数环境变量中设置
```

System Prompt 将用户输入明确标记为不可信内容。后端用 Zod 校验结果，非法 JSON/Schema 会安全重试一次，仍失败则返回错误；Draft 始终保留在 IndexedDB。

## 腾讯云函数部署

1. 在 CloudBase 创建一个环境，并创建集合 `ai_todo_state`。SDK 使用一条固定文档，通过服务端事务保证任务、设置、订阅和通知去重状态原子更新。
2. 在腾讯云创建上海区域 SCF，运行时选择 Node.js 20.19；或使用 `serverless.yml`。先执行 `pnpm run build`，函数入口是 `dist-server/scf.main`。
3. 配置 API 网关 HTTPS 触发器，将 `/api/{proxy+}` 转发到该函数。
4. 在函数环境变量中设置 `STORAGE_ADAPTER=cloudbase`、`CLOUDBASE_ENV_ID` 及 `.env.example` 的其他后端变量。不要把 secret 写入 `serverless.yml`。
5. 给函数角色授予目标 CloudBase 环境的最小数据库权限。SDK 可读取 `TENCENTCLOUD_SECRETID` / `TENCENTCLOUD_SECRETKEY`，也支持 `CLOUDBASE_APIKEY`。
6. 为函数 URL/API 网关绑定 HTTPS 域名，设置 `CORS_ORIGIN` 为 GitHub Pages URL。
7. 创建每分钟一次的定时触发器，请求 `POST /api/push/run-due`，Header 为 `Authorization: Bearer <CRON_SECRET>`。函数按同步的设备时区和汇总时间发送提醒。
8. 调用 `/api/health`、登录、AI、同步和 Push 订阅接口做部署后检查。

如果已有 CFS，也可设置 `STORAGE_ADAPTER=file` 与 `DATA_FILE=/mnt/ai-todo/todo.json`。SCF 的临时磁盘不应作为正式同步存储。

## 云同步

任务先写 IndexedDB，再进入 `syncQueue`，UI 不等待网络。在线后立即同步，失败则保留队列并在 `online` 事件或 60 秒轮询时重试。服务端和客户端都比较 `updatedAt`，较新版本获胜；删除使用 `deletedAt` tombstone，防止旧设备复活数据。

## Web Push

用户在设置页主动授权。每台设备会保存一条独立 subscription。通知失败不影响任务；410/404 的失效 subscription 会被清理。iOS 需要先把 PWA 添加到主屏幕，再在 PWA 内授权通知。

## GitHub Pages 与 Actions

1. 推送到 `main`。
2. 仓库 Settings → Pages → Source 选择 GitHub Actions。
3. 在 Actions Variables 设置 `VITE_API_URL` 和 `VITE_VAPID_PUBLIC_KEY`。
4. 工作流依据 `pnpm-lock.yaml` 执行冻结安装、typecheck、test、build；任一步失败都不会部署。

构建时 `BASE_URL` 自动使用仓库名，适配 Pages 子路径。

## PWA 安装

- iPhone/iPad Safari：分享 → 添加到主屏幕；Web Push 也要求从主屏幕启动。
- Android Chrome：菜单 → 安装应用。
- 桌面 Chromium：地址栏安装图标。

首次在线打开后，App Shell 与本地 IndexedDB 任务可离线使用；AI、云同步和 Push 注册需要网络。

## JSON Backup

导出结构含 `schemaVersion`、`exportedAt`、tasks、drafts、settings，不含 API Key、密码、JWT 或 Push 私钥。导入可选择合并或覆盖；合并按 UUID 去重并按 `updatedAt` 解决冲突。覆盖前建议先导出当前快照。

## 数据结构与迁移

`Task` 保持 `date`、`dateRange`、`time`、`endTime` 分离；`Draft` 独立记录 AI 状态和错误。IndexedDB 版本和 JSON `schemaVersion` 当前均为 1，升级时在 `src/storage/database.ts` 和 `migrateExport()` 增加逐版本 migration，禁止跳过旧版本。

## 安全说明

- AI Key 只由后端读取，前端 bundle、IndexedDB、localStorage 和 JSON 备份都不包含密钥。
- AI、Sync、Push、Health 均要求 JWT；提醒调度使用独立 `CRON_SECRET`。
- 登录和普通 API 分别受限流；请求体限制 256 KB，AI Inbox 上限 10,000 字。
- 生产必须替换示例 secret、启用 HTTPS、限制 CORS，并将 CloudBase/API 权限限制在该函数角色。

## 验证

```bash
pnpm run typecheck
pnpm run test
pnpm run build
```

当前自动化覆盖自然语言日期、明确/模糊时间、日期范围、URL、AI Schema/安全重试、IndexedDB CRUD/软删除/清理、并发同步队列、LWW/tombstone、旧 schema 和 ICS。真实 CloudBase、AI Provider、Web Push 到达和多设备同步需要部署后的端到端凭据与设备验证。

## V2 扩展钩子

- 增加新的 `AIProvider`，不改变 Inbox/UI
- 如需多账户，把单文档 CloudBase Adapter 扩展为按用户分区的集合
- 在 Task 已预留 `recurrence`；可增加周期任务 migration
- 在模型和搜索层增加 tags/category，不影响 V1 列表
- Push 调度已可扩展提前 10/30 分钟策略
- Repository 和 SyncChange 可复用到原生客户端

V1 有意不包含项目、标签、四象限、番茄钟、子任务、周期任务、团队、看板或 AI Chat。
