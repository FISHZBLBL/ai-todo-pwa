# AI Todo PWA

个人使用、移动端优先、离线优先的 AI 待办 PWA：快速记录 → 可选 AI 整理 → 用户确认 → 本地保存 → 后台同步与提醒。

## 已实现

- 快速添加、编辑、全局置顶、完成/恢复、软删除和 5 秒 Undo
- 日期分组、日历、组内拖动排序、过期提示和已完成历史
- 手动清单、AI 生成分组清单、逐项勾选、进度、归档和恢复
- 资料正文保存、编辑、复制与多设备同步
- AI Inbox、语音输入、草稿自动保存、确认预览；日期、时间和提醒分别处理
- IndexedDB 离线存储、同记录队列合并、按条数与字节分批同步、错误记录保留与导出
- 单用户密码哈希登录、JWT、失效会话回登录页、鉴权、限流和前后端共享 Zod 校验
- 设置页验证 DeepSeek Key，以 AES-256-GCM 加密后保存到所选云存储；浏览器不持久化 Key
- 多设备 Web Push、可设置时间的每日汇总、多条独立提醒、按天/周重复及有限次数倒计时
- PWA manifest、自定义 Service Worker、App Shell 缓存、iPhone Safe Area
- GitHub Actions 测试门禁；Netlify 前端/Functions 配置；腾讯云 COS 数据适配器

## 技术栈

- 前端：Vue 3、Composition API、Pinia、TypeScript、Vite
- 本地数据：IndexedDB（`idb`）
- PWA：`vite-plugin-pwa`、Workbox
- 后端：Netlify Functions、Node.js、Express 5、Zod、bcrypt、JWT、Web Push
- 提醒定时：Cloudflare Workers、SQLite-backed Durable Objects、Alarms
- 云存储：COS 私有桶、CloudBase 文档事务、CloudBase PostgreSQL；本地文件用于开发
- 测试：Vitest、fake-indexeddb、jsdom

## 项目结构

```text
src/
  components/       通用交互组件、任务行、编辑面板
  composables/      Web Speech 等浏览器能力
  repositories/     Task / Draft / Profile Repository
  services/         鉴权和 API 客户端
  storage/          IndexedDB schema 和 migration 入口
  stores/           Pinia 任务状态与操作
  sync/             离线同步队列和自动重连
  types/            数据模型
  utils/            日期、日历、清单和提醒
  views/            AI Inbox、清单、资料、日历、历史、设置、登录
  sw.ts             离线缓存、Push、通知点击
server/
  ai/               Provider、system prompt、输出 schema
  auth.ts           single-user authentication
  storage.ts        云端 LWW 存储适配器
  push.ts           VAPID Push 发送和每日汇总
  reminders/        Alarm 客户端、投递回调、迁移、重复规则和并发校验
  index.ts          API 路由、鉴权与限流
shared/             前后端共享 schema 和输入/同步限制
netlify/functions/  API、提醒与每日汇总业务处理、已退休的旧任务入口
cloudflare/
  reminder-alarm/   按需定时 Worker、SQLite 队列、独立 npm 锁文件与测试
scf/                腾讯云函数运行依赖和编译输出
tests/              日期、AI、清单、存储、同步、提醒和并发回归
```

## 本地运行

要求 Node.js 22+ 和项目指定的 pnpm 版本。服务端脚本用 Node 的 `--env-file-if-exists=.env.local` 加载配置。

```bash
pnpm install --frozen-lockfile
cp .env.example .env.local
```

先在 `.env.local` 填入有效 `PASSWORD_HASH` 和至少 24 字符的 `JWT_SECRET`，再分别启动两个终端：

```bash
pnpm run dev:server
pnpm run dev
```

`dev:server` 启动并监视 8787 端口的 API；`dev` 启动前端，Vite 将 `/api` 代理到本地 API。`pnpm run server` 启动不带文件监视的 API。登录门始终启用。默认本地配置可同步到文件；未设置提醒定时服务变量时不会登记云端提醒。

需要调试 Functions 时，另行安装/连接 Netlify CLI 后运行 `netlify dev`。提醒 Worker 的本地开发和独立部署见 [`cloudflare/reminder-alarm/README.md`](./cloudflare/reminder-alarm/README.md)。普通前后端开发不需要启动 Worker；提醒回归测试使用模拟投递，不发送真实通知。

## 环境变量

完整模板见 [`.env.example`](./.env.example)。敏感变量只放在后端：

| 变量 | 用途 |
| --- | --- |
| `PASSWORD_HASH` | bcrypt 密码哈希，禁止明文 |
| `JWT_SECRET` | 至少 24 字符的随机签名密钥 |
| `AI_PROVIDER` | 状态显示用的 Provider 名称；当前实现为 OpenAI-compatible |
| `AI_API_KEY` | 可选的服务端兜底密钥；通常由登录用户在设置页验证并加密保存 |
| `AI_BASE_URL` / `AI_MODEL` | OpenAI-compatible 服务地址和模型 |
| `STORAGE_ADAPTER` | `file`、`cos`、`cloudbase`、`cloudbase-postgres`；`cloudbase-storage` 仅只读 |
| `DATA_FILE` | `file` Adapter 的开发文件或 CFS 持久路径 |
| `CLOUDBASE_ENV_ID` | CloudBase 环境 ID；使用 CloudBase Adapter 时必填 |
| `CLOUDBASE_REGION` | CloudBase 区域，默认 `ap-shanghai` |
| `CLOUDBASE_COLLECTION` / `CLOUDBASE_DOCUMENT_ID` | 状态集合/表和固定记录 ID，默认 `ai_todo_state` / `single-user-state` |
| `CLOUDBASE_APIKEY` | PostgreSQL adapter 所需的服务端 API Key |
| `CLOUDBASE_STATE_PATH` | 只读 `cloudbase-storage` adapter 的对象路径 |
| `COS_BUCKET` / `COS_REGION` | 私有 COS 存储桶名称和地域 |
| `COS_SECRET_ID` / `COS_SECRET_KEY` | 目标桶对象读/写/删除权限及 `cos:GetBucketVersioning` 权限 |
| `COS_STATE_KEY` | 状态对象路径，默认 `ai-todo/state.json` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web Push VAPID 密钥对 |
| `REMINDER_SCHEDULER_URL` | Cloudflare 提醒 Worker 的根地址，如 `https://ai-todo-reminder-alarm.<subdomain>.workers.dev`；不要附加路径、查询参数或凭据 |
| `REMINDER_SCHEDULER_SECRET` | 后端与 Worker 共用的认证密钥，至少 32 字符且不含空白；建议用 32 个随机字节生成 |
| `APP_TIMEZONE` | 服务端提醒计算时区，默认 `Asia/Shanghai` |
| `VITE_API_URL` | 公开 API 根地址，如 `https://api.example.com/api` |
| `VITE_VAPID_PUBLIC_KEY` | 旧版前端构建变量；新版从认证 `/api/push/config` 读取当前公钥，无需设置 |

生成密码哈希、随机密钥和 VAPID 密钥：

```bash
node -e "import('bcryptjs').then(async b => console.log(await b.hash(process.argv[1], 12)))" "你的密码"
node -e "import('node:crypto').then(c => console.log(c.randomBytes(32).toString('hex')))"
pnpm exec web-push generate-vapid-keys
```

随机密钥命令应为 `JWT_SECRET` 和 `REMINDER_SCHEDULER_SECRET` 分别执行，使用不同结果。不要把命令输出提交到 Git。`.env`、`.env.local` 和 `data/` 已被忽略。Worker 的 `.dev.vars`、`.wrangler/` 和 `node_modules/` 也被子目录的 `.gitignore` 忽略。

## AI Provider 配置

业务层依赖 `AIProvider` 接口。登录后可在设置页验证、替换或删除个人 DeepSeek Key。验证成功后，后端使用由 `JWT_SECRET` 派生的 AES-256-GCM 密钥加密，并写入所选存储；前端只收到掩码状态。更换 `JWT_SECRET` 后需重新配置已保存的 Key。也可以使用服务端环境变量作为兜底：

```env
AI_PROVIDER=deepseek
AI_BASE_URL=https://api.deepseek.com
AI_MODEL=deepseek-chat
AI_API_KEY=在云函数环境变量中设置
```

后端用 Zod 校验 AI 输出；非法 JSON、Schema、网络或普通 HTTP 错误直接返回错误并保留草稿。只有 Provider 明确不支持 JSON mode 时，关闭 JSON mode 再请求一次。资料正文是普通同步记录，AI 设置中的密钥才使用上述加密流程。

## Netlify + 腾讯 COS + Cloudflare Alarm 部署

1. 在腾讯云 COS 新建私有存储桶，要求从未开启版本控制；已暂停版本控制的桶也不符合此锁方案要求。
2. 创建仅允许目标桶对象读取、写入、删除及查询桶版本配置（`cos:GetBucketVersioning`）的 CAM 凭据。
3. 在 Netlify 新建项目并连接本仓库；构建配置已写入 `netlify.toml`。
4. 构建使用 Node.js 22+。提醒定时服务独立部署到 Cloudflare，不需要安装 Netlify Async Workloads Extension。
5. 在 Netlify Functions 环境变量中设置 `PASSWORD_HASH`、`JWT_SECRET`、`STORAGE_ADAPTER=cos`、`COS_BUCKET`、`COS_REGION`、`COS_SECRET_ID`、`COS_SECRET_KEY`、VAPID 变量和 `APP_TIMEZONE=Asia/Shanghai`。
6. 按下文配置并发布提醒 Worker，设置 Netlify Functions 中的两个 `REMINDER_SCHEDULER_*` 变量，再发布应用。
7. 部署后验证登录、同步和 DeepSeek Key 保存，再在 iPhone 主屏幕 PWA 中授权通知。已有站点迁移还必须执行后面的旧队列退役与 bootstrap 步骤。

网页、登录和 API 默认使用同域 `/api`。任务数据仍保存在所选存储中，Web Push 仍由现有 API 后端发送；只有提醒时间和事件状态交给 Cloudflare Durable Object。

### 发布提醒 Worker

1. 使用有 Workers / Durable Objects 权限的 Cloudflare 账号。子目录有自己的 `package-lock.json`，从该目录执行 `npm ci`，再用 Wrangler 登录所选账号。
2. 检查 `cloudflare/reminder-alarm/wrangler.jsonc`。`REMINDER_CALLBACK_URL` 必须指向实际生产 API 的固定 HTTPS 路径 `/api/reminders/deliver`；仓库默认是 `https://ai-todo-pwa.netlify.app/api/reminders/deliver`。它不是浏览器地址，也不从单个提醒请求中传入。
3. 在该目录运行 `npx wrangler secret put REMINDER_SCHEDULER_SECRET`，以交互方式保存独立生成的共享密钥，再执行 `npm run deploy`。Wrangler 会按配置建立 SQLite-backed `ReminderAlarm` Durable Object。
4. 在 Netlify Functions 环境中设置 `REMINDER_SCHEDULER_URL` 为发布后的 Worker 根地址，`REMINDER_SCHEDULER_SECRET` 为同一共享密钥。它们都不是前端构建变量；不要加 `VITE_` 前缀。
5. 重新发布 API。Worker 的 `GET /health` 应返回 `{ "ready": true }`；登录后访问 API 的 `GET /api/reminders/status`，确认连接成功。前者只检查 Worker 配置，不能代替一次端到端提醒测试。

### 已有 Netlify 队列的迁移顺序

先发布并验证空的 Worker，再发布包含旧入口退役的生产应用，最后显式迁移。不要让两套生产投递器同时运行。

1. 先保存云端状态备份，并完成上面的 Worker 与后端环境配置。
2. 发布本版本 API，确认生产环境的旧 `todo-reminder`、`daily-summary`、`reminder-maintenance` HTTP 入口返回 410。它们的业务处理已改走 `/api/reminders/deliver`，没有定时维护配置。
3. 确认已发布部署不再包含 `async-workloads-scheduler` 等生成任务，且生产定时任务列表中没有旧队列或维护 cron。本版移除了全部 `asyncWorkloadConfig` 导出，Extension 不再为本站生成内部函数；无需卸载影响其他站点的团队级 Extension。旧 `AWL_API_KEY`、`AWL_SCHEDULER_INTERVAL` 不再供本应用使用。等待迁移前已经开始的旧投递执行结束，再进入下一步。
4. 登录后带用户 JWT 显式调用 `POST /api/reminders/bootstrap`；管理员也可使用共享 scheduler Bearer 密钥调用。此接口按需读取当前状态，为未登记的提醒补登记，并用原事件 ID 导入仍有效的旧提醒。没有订阅时会清理待投递指针，不创建空汇总。
5. 如果返回 503，先处理配置或存储问题，再重试同一接口；重复导入不会重新安排已登记的相同事件。`GET /api/reminders/status` 需要用户 JWT，返回计数与下次唤醒时间，不返回事项内容。
6. 最后检查已存在的未来提醒，并从应用新建一个近期提醒，在目标设备上验证送达。确认生产版本、Worker、订阅、公钥配置均正常后，迁移才算完成。

示例请求中的 JWT 是登录接口返回的会话 token；不要将实际 token 或共享密钥写入仓库、截图或共享日志：

```bash
curl -X POST 'https://ai-todo-pwa.netlify.app/api/reminders/bootstrap' \
  -H 'Authorization: Bearer <登录后的JWT>'
curl 'https://ai-todo-pwa.netlify.app/api/reminders/status' \
  -H 'Authorization: Bearer <登录后的JWT>'
```

### 提醒的执行与资源使用

事项新增、修改、删除、提醒设置变更或设备订阅变更时安排和取消相关事件。Worker 用索引查最早事件，只为该时间设置一个 Alarm；没有待执行或重试事件就调用 `deleteAlarm()`。不配置 Cloudflare Cron Trigger，也不运行 Netlify 每分钟队列轮询或定期全量维护。参考 [Cloudflare Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)。

单次提醒到点后执行通知；重复提醒在本次处理完成时直接安排下一次。每日汇总保留，按设置中的当地时间和时区执行，默认 08:00；仅在有推送订阅且存在未完成事项时保留下一次汇总事件，条件不满足就取消，之后由事项或订阅变更恢复。

已登记事件遇到网络错误、429 或 5xx，会针对该真实事件按 1、2、4、8、16、32 分钟退避，之后最多每小时重试一次；不是空队列扫描。401/403 等永久错误会将事件保留为 `dead`，需修复配置并在应用中重新设置受影响提醒。登记本身失败时，客户端保留待处理变更，联网或返回前台后重试；云端不再靠周期扫描补排。

Cloudflare Alarm 提供至少一次执行。事件 ID、取消墓碑、投递 lease 和持久化步骤缓存用于避免常见重复执行；外部 Push 已接收而响应丢失时仍有不确定性，不能保证严格恰好一次。正常提醒无需等待固定轮询，但云端唤醒、网络和系统通知策略仍可能造成延迟。资源消耗取决于真实事件、重试、执行时长和存储，不能据此断言免费。

前台保留每分钟多设备同步；页面进入后台且没有待上传变更时，暂停空轮询。空同步只读快照，不扫描提醒或重写云端状态；后台仍上传待同步修改，返回前台或恢复联网时立即刷新。Web Push 最多同时发送 4 个端点，每个请求设 10 秒 socket 空闲超时。

COS 写入使用不自动过期的独占锁。发生状态 PUT 超时等不确定结果时保留锁，后续写入会报错，避免晚到请求覆盖新数据。恢复孤儿锁前必须停止全部写入并确认旧请求结束，再由管理员删除 `${COS_STATE_KEY}.lock`；不要根据锁龄自动删除。若需要自动故障恢复，使用事务 `cloudbase` 或 PostgreSQL adapter。安全前提见 [COS PUT Object](https://cloud.tencent.com/document/product/436/7749) 与 [桶版本配置](https://cloud.tencent.com/document/api/436/19888)。

## 腾讯云函数部署

1. 在 CloudBase 创建一个环境，并创建集合 `ai_todo_state`。SDK 使用一条固定文档，通过服务端事务保证任务、设置、订阅和通知去重状态原子更新。
2. 在腾讯云创建上海区域 SCF，运行时选择 Node.js 20.19；或使用 `serverless.yml`。用本地 Node.js 22+ 执行 `pnpm run build`，共享 schema 与服务端一起输出到 `scf/dist-server/`。入口文件为 `scf/dist-server/server/scf.js`；以 `scf/` 为部署目录时，handler 为 `dist-server/server/scf.main`。
3. 配置 API 网关 HTTPS 触发器，将 `/api/{proxy+}` 转发到该函数。
4. 在函数环境变量中设置 `STORAGE_ADAPTER=cloudbase`、`CLOUDBASE_ENV_ID` 及 `.env.example` 的其他后端变量。不要把 secret 写入 `serverless.yml`。
5. 给函数角色授予目标 CloudBase 环境的最小数据库权限。若使用 `cloudbase-postgres`，配置服务端 `CLOUDBASE_APIKEY` 并先建立状态表；表中固定记录不存在时会自动 insert 初始化，再按 `version` 比较并重试并发写入。文档事务 adapter 使用函数角色凭据。
6. 为函数 URL/API 网关绑定 HTTPS 域名，设置 `CORS_ORIGIN` 为 GitHub Pages URL。
7. 部署时安装 `scf/package.json` 的生产依赖。SCF 和普通 Express 后端也可配置 `REMINDER_SCHEDULER_URL` 与 `REMINDER_SCHEDULER_SECRET` 使用同一 Alarm 定时服务；将 Worker 的固定 callback 改为此后端的公开 HTTPS `/api/reminders/deliver`，不依赖 Netlify 上下文。一个生产队列只回调其对应的数据后端。
8. 调用 `/api/health`、登录、AI、同步和 Push 订阅接口做部署后检查。

如果已有共享持久磁盘，可设置 `STORAGE_ADAPTER=file` 与对应 `DATA_FILE`；SCF 临时磁盘不适合正式同步存储。`cloudbase-storage` 仅提供旧对象状态读取，会明确拒绝同步写入和其他 mutation；写入请改用 `cloudbase` 等安全 adapter，并先迁移已有数据。

PostgreSQL adapter 需要以下状态表（集合名配置为其他值时同步替换表名），并给服务端凭据授予该表的 SELECT、INSERT、UPDATE 权限；固定记录由首次写入初始化：

```sql
CREATE TABLE public.ai_todo_state (
  id text PRIMARY KEY,
  state jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

## 云同步

任务、清单、草稿、资料与设置先写 IndexedDB，再进入 `syncQueue`。同步会合并同一记录的旧修改，按最多 1000 条和 240 KiB 分批；网络失败保留队列，重新联网或 60 秒轮询后重试。不符合共享 schema 的历史记录保留在本机，可在设置页查看原因并导出待恢复内容。

较新 `updatedAt` 版本获胜；本地写入、远端合并和队列确认采用事务，避免并发覆盖。完整删除 tombstone 保留 30 天，云端清理正文后继续保留最小删除版本，并返回给旧设备，阻止较旧离线记录复活。云端数据保存成功但提醒登记未完成时，响应包含 `reminderSchedulingPending`，客户端保留相应队列变更继续重试，不依赖定期维护扫描。

## Web Push

用户在设置页主动授权。前端从认证 `/api/push/config` 读取当前公钥和调度状态；服务端验证 P-256 公私钥匹配，仅返回公钥，私钥保持在 Functions 环境变量中。修改 Functions 配置后必须重新部署，GitHub 代码更新与线上部署成功需要分别确认。

每台设备会保存一条独立 subscription，并可独立取消。浏览器显示“已订阅”前会核验服务端记录，VAPID 公钥变化时用户再次开启通知会重建订阅；410/404 的失效 subscription 会被清理。无订阅时提醒会解除事件指针并等待订阅；设备订阅后按需恢复未登记的提醒，未来与已发送提醒保留。不再有维护函数反复创建空事件。

任务安排使用 `dueDate/dateRange/startTime/endTime`；提醒独立使用 `reminderMode` 与 `reminders[]`。每条提醒有自己的 ID、时间、事件 ID 和发送状态，可按天或周重复，按次数或截止日期结束。倒计时包含重复间隔。投递回调发送前重新核对任务与事件；成功步骤持久化缓存，后续状态保存失败可继续重试。重复提醒在回调中直接安排并绑定下一次，无需维护扫描。

每日汇总包含逾期和当天未完成任务，按当地日期去重。iOS 需先把 PWA 添加到主屏幕，再从 PWA 内授权通知。Alarm 唤醒、网络和浏览器推送可能产生延迟；真实送达需要部署后在目标设备实测。

## GitHub Actions

1. 推送到 `main` 或创建/更新以 `main` 为目标的 Pull Request；也可手动触发。
2. 工作流依据 `pnpm-lock.yaml` 执行冻结安装、typecheck、test、build；任一步失败即停止工作流。
3. Netlify 自身构建也执行 typecheck、test、build 任一步失败即停止；GitHub Actions 的检查结果是否作为发布条件，取决于项目的 Git/部署规则配置。

## PWA 安装

- iPhone/iPad Safari：分享 → 添加到主屏幕；Web Push 也要求从主屏幕启动。
- Android Chrome：菜单 → 安装应用。
- 桌面 Chromium：地址栏安装图标。

首次在线打开后，App Shell 与本地 IndexedDB 任务可离线使用；AI、云同步和 Push 注册需要网络。

## 数据结构与迁移

IndexedDB 当前版本为 3，包含任务/清单、草稿、资料、同步队列和设置。Repository 会兼容旧版 `date/time` 和单条提醒字段；前后端共用 `shared/syncSchema.ts`，本地保存和上传都做校验。现有页面没有全局搜索、ICS 或完整 JSON 备份导入/导出入口；设置页的 JSON 导出仅用于恢复同步错误记录。

## 安全说明

- AI 设置 Key 只由后端读取；保存时使用 AES-256-GCM 加密，前端持久化只保存掩码状态。
- AI、Sync、Push、Health 和提醒状态接口要求 JWT；Alarm 投递回调只接受共享 `REMINDER_SCHEDULER_SECRET` 的 Bearer 认证，bootstrap 接受用户 JWT 或该共享密钥。VAPID 私钥只在 API 后端，共享密钥只在 API 后端与 Worker secret 配置中。
- 登录和普通 API 分别受限流；请求体限制 256 KiB，AI Inbox 上限 10,000 字。直连后端使用 socket 客户端地址，避免自带转发头绕过限流。
- 生产必须替换示例 secret、启用 HTTPS、限制 CORS，并将 CloudBase/API 权限限制在该函数角色。

## 验证

```bash
pnpm run typecheck
pnpm run test
pnpm run build
```

`typecheck` 检查前端、后端与 Alarm Worker；`test` 运行 Vitest，包含 Worker 队列和 SQLite HTTP 契约；`build` 生成 `dist/` 和 `scf/dist-server/`，不会嵌套调用 pnpm。仅编译服务端可用 `pnpm run build:server`。Worker 使用独立的 npm 锁文件与 Wrangler 发布流程。

自动化覆盖 AI 输出、日期、清单、输入上限、同步分批与并发、删除版本、COS 安全锁、CloudBase/PostgreSQL、Alarm 登记与取消、投递重试、重复提醒续排、迁移和空队列休眠。真实 AI 用例默认跳过，仅设置 `DEEPSEEK_LIVE_TEST=1` 时执行并调用配置的 Provider。默认测试使用本地 mock；真实 COS、AI 和 iPhone 推送链路需要单独验证。
