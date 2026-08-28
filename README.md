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
- 单用户密码哈希登录、JWT、失效会话回登录页、鉴权、限流、AI Provider 抽象和 Zod 校验
- 设置页验证 DeepSeek Key，以 AES-256-GCM 加密后保存到私有 COS；浏览器不持久化 Key
- 多设备 Web Push 订阅、08:00 每日汇总、Todo 独立提醒和 Netlify Async Workloads 延迟事件
- PWA manifest、自定义 Service Worker、App Shell 缓存、iPhone Safe Area
- GitHub Actions 测试门禁；Netlify 前端/Functions 配置；腾讯云 COS 数据适配器

## 技术栈

- 前端：Vue 3、Composition API、Pinia、TypeScript、Vite
- 本地数据：IndexedDB（`idb`）
- PWA：`vite-plugin-pwa`、Workbox
- 后端：Netlify Functions、Node.js、Express 5、Zod、bcrypt、JWT、Web Push
- 云存储：腾讯云 COS 私有存储桶（CloudBase/PostgreSQL Adapter 仍保留为可选项）
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
  push.ts           VAPID Push 发送和每日汇总
  reminders/        Async Workloads 创建、替换和取消
  index.ts          API 路由、鉴权与限流
tests/              日期、AI schema、Storage、Sync、Import/Export
```

## 本地运行

要求 Node.js 20+。

```bash
pnpm install
cp .env.example .env.local
pnpm run netlify:dev
```

只调试传统本地 API 时，也可以分别启动：

```bash
pnpm run dev:server
```

登录门始终启用。Netlify 部署和 `netlify dev` 默认使用同域 `/api`，通常不需要配置 `VITE_API_URL`。

## 环境变量

完整模板见 [`.env.example`](./.env.example)。敏感变量只放在后端：

| 变量 | 用途 |
| --- | --- |
| `PASSWORD_HASH` | bcrypt 密码哈希，禁止明文 |
| `JWT_SECRET` | 至少 24 字符的随机签名密钥 |
| `AI_PROVIDER` | Provider 名称，仅用于状态和切换 |
| `AI_API_KEY` | 可选的服务端兜底密钥；通常由登录用户在设置页验证并加密保存 |
| `AI_BASE_URL` / `AI_MODEL` | OpenAI-compatible 服务地址和模型 |
| `STORAGE_ADAPTER` | `file`、`cos`、`cloudbase` 或 `cloudbase-postgres`；Netlify 生产推荐 `cos` |
| `DATA_FILE` | `file` Adapter 的开发文件或 CFS 持久路径 |
| `CLOUDBASE_ENV_ID` | CloudBase 环境 ID；使用 CloudBase Adapter 时必填 |
| `CLOUDBASE_REGION` | CloudBase 区域，默认 `ap-shanghai` |
| `CLOUDBASE_COLLECTION` | 状态集合，默认 `ai_todo_state` |
| `COS_BUCKET` / `COS_REGION` | 私有 COS 存储桶名称和地域 |
| `COS_SECRET_ID` / `COS_SECRET_KEY` | 仅可访问该桶的最小权限服务端凭据 |
| `COS_STATE_KEY` | 状态对象路径，默认 `ai-todo/state.json` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web Push VAPID 密钥对 |
| `AWL_API_KEY` | Netlify Async Workloads 站点 API Key；Starter/Free 方案需在项目中创建 |
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

业务层只依赖 `AIProvider` 接口。登录后可在设置页验证、替换或删除个人 DeepSeek Key。Key 经 HTTPS 发送到同域 Function，验证成功后使用由 `JWT_SECRET` 派生的 AES-256-GCM 密钥加密，再写入私有 COS。前端只收到掩码状态。也可以使用服务端环境变量作为兜底：

```env
AI_PROVIDER=deepseek
AI_BASE_URL=https://api.deepseek.com
AI_MODEL=deepseek-chat
AI_API_KEY=在云函数环境变量中设置
```

System Prompt 将用户输入明确标记为不可信内容。后端用 Zod 校验结果，非法 JSON/Schema 会安全重试一次，仍失败则返回错误；Draft 始终保留在 IndexedDB。

## Netlify + 腾讯 COS 部署

1. 在腾讯云 COS 新建私有存储桶，建议与主要用户接近的地域。
2. 创建仅允许该桶对象读取、写入和删除的最小权限 CAM 凭据。
3. 在 Netlify 新建项目并连接本仓库；构建配置已写入 `netlify.toml`。
4. 为 Netlify 团队安装官方 Async Workloads Extension；Starter/Free 方案在项目的 **Build & Deploy → Async Workloads** 创建站点级 `AWL_API_KEY`。
5. 在 Netlify Functions 环境变量中设置 `PASSWORD_HASH`、`JWT_SECRET`、`STORAGE_ADAPTER=cos`、`COS_BUCKET`、`COS_REGION`、`COS_SECRET_ID`、`COS_SECRET_KEY`、VAPID 变量和 `APP_TIMEZONE=Asia/Shanghai`。
6. 部署后先验证登录、同步和 DeepSeek Key 保存，再在 iPhone 主屏幕 PWA 中授权通知。

网页、登录和 API 使用同一个 `*.netlify.app` 域名，不需要跨域配置，也没有 CloudBase 默认域名中间页。`daily-summary` 每天 UTC 00:00（上海 08:00）运行一次；单项提醒由 `todo-reminder` Async Workload 延迟事件触发，不扫描 Todo 表。

## 腾讯云函数部署

1. 在 CloudBase 创建一个环境，并创建集合 `ai_todo_state`。SDK 使用一条固定文档，通过服务端事务保证任务、设置、订阅和通知去重状态原子更新。
2. 在腾讯云创建上海区域 SCF，运行时选择 Node.js 20.19；或使用 `serverless.yml`。先执行 `pnpm run build`，函数入口是 `dist-server/scf.main`。
3. 配置 API 网关 HTTPS 触发器，将 `/api/{proxy+}` 转发到该函数。
4. 在函数环境变量中设置 `STORAGE_ADAPTER=cloudbase`、`CLOUDBASE_ENV_ID` 及 `.env.example` 的其他后端变量。不要把 secret 写入 `serverless.yml`。
5. 给函数角色授予目标 CloudBase 环境的最小数据库权限。SDK 可读取 `TENCENTCLOUD_SECRETID` / `TENCENTCLOUD_SECRETKEY`，也支持 `CLOUDBASE_APIKEY`。
6. 为函数 URL/API 网关绑定 HTTPS 域名，设置 `CORS_ORIGIN` 为 GitHub Pages URL。
7. CloudBase 预览函数不再配置任何提醒 Timer；完整提醒链路只在 Netlify Async Workloads 上运行。
8. 调用 `/api/health`、登录、AI、同步和 Push 订阅接口做部署后检查。

如果已有 CFS，也可设置 `STORAGE_ADAPTER=file` 与 `DATA_FILE=/mnt/ai-todo/todo.json`。SCF 的临时磁盘不应作为正式同步存储。

## 云同步

任务先写 IndexedDB，再进入 `syncQueue`，UI 不等待网络。在线后立即同步，失败则保留队列并在 `online` 事件或 60 秒轮询时重试。服务端和客户端都比较 `updatedAt`，较新版本获胜；删除使用 `deletedAt` tombstone，防止旧设备复活数据。

## Web Push

用户在设置页主动授权。每台设备会保存一条独立 subscription，并可独立取消。浏览器显示“已订阅”前会核验服务端记录，VAPID 公钥变化时会重新订阅；410/404 的失效 subscription 会被清理。

任务的 `dueDate/startTime/endTime` 只描述任务安排，`reminderEnabled/reminderAt` 独立描述提醒。创建或修改提醒时发送只含 `todoId` 的延迟事件并保存 `reminderEventId`；完成、删除、关闭提醒或改时间会取消旧事件。Workload 到点后重新读取 Todo 并核对 event ID，发送成功后写入 `reminderSentAt`。iOS 需要先把 PWA 添加到主屏幕，再从 PWA 内授权通知。

## GitHub Actions

1. 推送到 `main`。
2. 工作流依据 `pnpm-lock.yaml` 执行冻结安装、typecheck、test、build；任一步失败都会阻止后续发布。
3. Netlify 可直接监听 GitHub `main` 分支，在 CI 通过后构建发布。

## PWA 安装

- iPhone/iPad Safari：分享 → 添加到主屏幕；Web Push 也要求从主屏幕启动。
- Android Chrome：菜单 → 安装应用。
- 桌面 Chromium：地址栏安装图标。

首次在线打开后，App Shell 与本地 IndexedDB 任务可离线使用；AI、云同步和 Push 注册需要网络。

## JSON Backup

导出结构含 `schemaVersion`、`exportedAt`、tasks、drafts、settings，不含 API Key、密码、JWT 或 Push 私钥。导入可选择合并或覆盖；合并按 UUID 去重并按 `updatedAt` 解决冲突。覆盖前建议先导出当前快照。

## 数据结构与迁移

`Task` 保持 `dueDate`、`dateRange`、`startTime`、`endTime` 与提醒字段分离；`Draft` 独立记录 AI 状态和错误。IndexedDB 版本和 JSON `schemaVersion` 当前均为 2；导入和 Repository 会把旧版 `date/time` 自动迁移为 `dueDate/startTime`，并默认关闭提醒。

## 安全说明

- AI Key 只由后端读取；保存时使用 AES-256-GCM 加密，前端 bundle、IndexedDB、localStorage 和 JSON 备份都不包含密钥。
- AI、Sync、Push、Health 均要求 JWT；Async Workloads 使用 Netlify 管理的 `AWL_API_KEY`，VAPID 私钥只存在于服务端环境变量。
- 登录和普通 API 分别受限流；请求体限制 256 KB，AI Inbox 上限 10,000 字。
- 生产必须替换示例 secret、启用 HTTPS、限制 CORS，并将 CloudBase/API 权限限制在该函数角色。

## 验证

```bash
pnpm run typecheck
pnpm run test
pnpm run build
```

当前自动化覆盖自然语言日期、明确/模糊时间、日期范围、URL、AI Schema/安全重试、IndexedDB CRUD/软删除/清理、并发同步队列、LWW/tombstone、旧 schema、ICS、提醒事件创建/取消和 Workload 幂等校验。真实 Web Push 到达仍必须在部署后的 iPhone 主屏幕 PWA 上验证。

## V2 扩展钩子

- 增加新的 `AIProvider`，不改变 Inbox/UI
- 如需多账户，把单文档 CloudBase Adapter 扩展为按用户分区的集合
- 在 Task 已预留 `recurrence`；可增加周期任务 migration
- 在模型和搜索层增加 tags/category，不影响 V1 列表
- 可在独立 `reminderAt` 基础上扩展提前 10/30 分钟策略
- Repository 和 SyncChange 可复用到原生客户端

V1 有意不包含项目、标签、四象限、番茄钟、子任务、周期任务、团队、看板或 AI Chat。
