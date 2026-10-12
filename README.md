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
  reminders/        调度、维护、重复规则和并发校验
  index.ts          API 路由、鉴权与限流
shared/             前后端共享 schema 和输入/同步限制
netlify/functions/  API、提醒 workload、每日汇总与定时维护
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

`dev:server` 启动并监视 8787 端口的 API；`dev` 启动前端，Vite 将 `/api` 代理到本地 API。`pnpm run server` 启动不带文件监视的 API。登录门始终启用。默认本地配置可同步到文件，但不会创建 Netlify 提醒事件。

需要调试 Functions 时，另行安装/连接 Netlify CLI 后运行 `netlify dev`。仓库没有 `netlify:dev` npm 脚本；定时维护需手动运行 `netlify functions:invoke reminder-maintenance`，本地不会自动按 cron 执行。

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
| `AWL_API_KEY` | Netlify Async Workloads API Key，在项目或团队 Extension 设置中配置 |
| `APP_TIMEZONE` | 服务端提醒计算时区，默认 `Asia/Shanghai` |
| `VITE_API_URL` | 公开 API 根地址，如 `https://api.example.com/api` |
| `VITE_VAPID_PUBLIC_KEY` | 旧版前端构建变量；新版从认证 `/api/push/config` 读取当前公钥，无需设置 |

生成密码哈希、JWT 签名密钥和 VAPID 密钥：

```bash
node -e "import('bcryptjs').then(async b => console.log(await b.hash(process.argv[1], 12)))" "你的密码"
node -e "import('node:crypto').then(c => console.log(c.randomBytes(32).toString('hex')))"
pnpm exec web-push generate-vapid-keys
```

不要把命令输出提交到 Git。`.env`、`.env.local` 和 `data/` 已被忽略。

## AI Provider 配置

业务层依赖 `AIProvider` 接口。登录后可在设置页验证、替换或删除个人 DeepSeek Key。验证成功后，后端使用由 `JWT_SECRET` 派生的 AES-256-GCM 密钥加密，并写入所选存储；前端只收到掩码状态。更换 `JWT_SECRET` 后需重新配置已保存的 Key。也可以使用服务端环境变量作为兜底：

```env
AI_PROVIDER=deepseek
AI_BASE_URL=https://api.deepseek.com
AI_MODEL=deepseek-chat
AI_API_KEY=在云函数环境变量中设置
```

后端用 Zod 校验 AI 输出；非法 JSON、Schema、网络或普通 HTTP 错误直接返回错误并保留草稿。只有 Provider 明确不支持 JSON mode 时，关闭 JSON mode 再请求一次。资料正文是普通同步记录，AI 设置中的密钥才使用上述加密流程。

## Netlify + 腾讯 COS 部署

1. 在腾讯云 COS 新建私有存储桶，要求从未开启版本控制；已暂停版本控制的桶也不符合此锁方案要求。
2. 创建仅允许目标桶对象读取、写入、删除及查询桶版本配置（`cos:GetBucketVersioning`）的 CAM 凭据。
3. 在 Netlify 新建项目并连接本仓库；构建配置已写入 `netlify.toml`。
4. 安装官方 Async Workloads Extension，在 **Project configuration → Developer settings → Async Workloads** 配置站点 Key（或使用团队 Key）。构建使用 Node.js 22+。
5. 在 Netlify Functions 环境变量中设置 `PASSWORD_HASH`、`JWT_SECRET`、`STORAGE_ADAPTER=cos`、`COS_BUCKET`、`COS_REGION`、`COS_SECRET_ID`、`COS_SECRET_KEY`、VAPID 变量和 `APP_TIMEZONE=Asia/Shanghai`。
6. 部署后先验证登录、同步和 DeepSeek Key 保存，再在 iPhone 主屏幕 PWA 中授权通知。

网页、登录和 API 默认使用同域 `/api`。每日汇总按设置中的当地时间与时区执行，默认 08:00；单项提醒由 Async Workload 延迟事件发送。

`reminder-maintenance` 每 5 分钟检查待调度状态，创建独立根事件，续排重复提醒和每日汇总，避免累计触发 SDK 默认 20 次事件链限制。普通同步不会取消已经到点、正在投递或重试的汇总；超过一小时的汇总由维护函数尝试恢复。参考 [事件链限制](https://docs.netlify.com/build/async-workloads/optional-configuration/)。

定时维护仅在 published 生产部署自动执行。Deploy Preview、branch deploy 和 Netlify Dev 需要在 Functions 页面点击 **Run now** 或本地手动 invoke，不能用预览部署验证长期自动续排。参考 [Scheduled Functions](https://docs.netlify.com/build/functions/scheduled-functions/)。

COS 写入使用不自动过期的独占锁。发生状态 PUT 超时等不确定结果时保留锁，后续写入会报错，避免晚到请求覆盖新数据。恢复孤儿锁前必须停止全部写入并确认旧请求结束，再由管理员删除 `${COS_STATE_KEY}.lock`；不要根据锁龄自动删除。若需要自动故障恢复，使用事务 `cloudbase` 或 PostgreSQL adapter。安全前提见 [COS PUT Object](https://cloud.tencent.com/document/product/436/7749) 与 [桶版本配置](https://cloud.tencent.com/document/api/436/19888)。

## 腾讯云函数部署

1. 在 CloudBase 创建一个环境，并创建集合 `ai_todo_state`。SDK 使用一条固定文档，通过服务端事务保证任务、设置、订阅和通知去重状态原子更新。
2. 在腾讯云创建上海区域 SCF，运行时选择 Node.js 20.19；或使用 `serverless.yml`。用本地 Node.js 22+ 执行 `pnpm run build`，共享 schema 与服务端一起输出到 `scf/dist-server/`。入口文件为 `scf/dist-server/server/scf.js`；以 `scf/` 为部署目录时，handler 为 `dist-server/server/scf.main`。
3. 配置 API 网关 HTTPS 触发器，将 `/api/{proxy+}` 转发到该函数。
4. 在函数环境变量中设置 `STORAGE_ADAPTER=cloudbase`、`CLOUDBASE_ENV_ID` 及 `.env.example` 的其他后端变量。不要把 secret 写入 `serverless.yml`。
5. 给函数角色授予目标 CloudBase 环境的最小数据库权限。若使用 `cloudbase-postgres`，配置服务端 `CLOUDBASE_APIKEY` 并先建立状态表；表中固定记录不存在时会自动 insert 初始化，再按 `version` 比较并重试并发写入。文档事务 adapter 使用函数角色凭据。
6. 为函数 URL/API 网关绑定 HTTPS 域名，设置 `CORS_ORIGIN` 为 GitHub Pages URL。
7. `scf/package.json` 已包含模块加载所需的 `@netlify/async-workloads`，部署时安装该目录的生产依赖。SCF 和普通 Express 后端允许正常同步，但没有 Netlify 上下文时跳过提醒调度；完整自动提醒需要 Netlify 部署。
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

较新 `updatedAt` 版本获胜；本地写入、远端合并和队列确认采用事务，避免并发覆盖。完整删除 tombstone 保留 30 天，云端清理正文后继续保留最小删除版本，并返回给旧设备，阻止较旧离线记录复活。云端数据成功保存后，即使 Netlify 调度暂时失败也会确认同步，维护函数继续补排提醒。

## Web Push

用户在设置页主动授权。前端从认证 `/api/push/config` 读取当前公钥和调度状态；服务端验证 P-256 公私钥匹配，仅返回公钥，私钥保持在 Functions 环境变量中。修改 Functions 配置后必须重新部署，GitHub 代码更新与线上部署成功需要分别确认。

每台设备会保存一条独立 subscription，并可独立取消。浏览器显示“已订阅”前会核验服务端记录，VAPID 公钥变化时用户再次开启通知会重建订阅；410/404 的失效 subscription 会被清理。无订阅时到期的提醒会解除事件指针并等待订阅；首个设备订阅后补排未发送的到期提醒，未来与已发送提醒保留。维护函数在没有订阅时不反复创建事件。

任务安排使用 `dueDate/dateRange/startTime/endTime`；提醒独立使用 `reminderMode` 与 `reminders[]`。每条提醒有自己的 ID、时间、事件 ID 和发送状态，可按天或周重复，按次数或截止日期结束。倒计时包含重复间隔。Workload 发送前重新核对任务与事件，失败在步骤内部抛错以允许真正重试；成功后推进下一次，由维护函数创建新的根事件。

每日汇总包含逾期和当天未完成任务，按当地日期去重。iOS 需先把 PWA 添加到主屏幕，再从 PWA 内授权通知。维护频率、Async Workloads 队列与浏览器推送都可能产生延迟；真实送达需要部署后实测。

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
- AI、Sync、Push、Health 均要求 JWT；Async Workloads 使用 Netlify 管理的 `AWL_API_KEY`，VAPID 私钥只存在于服务端环境变量。
- 登录和普通 API 分别受限流；请求体限制 256 KiB，AI Inbox 上限 10,000 字。直连后端使用 socket 客户端地址，避免自带转发头绕过限流。
- 生产必须替换示例 secret、启用 HTTPS、限制 CORS，并将 CloudBase/API 权限限制在该函数角色。

## 验证

```bash
pnpm run typecheck
pnpm run test
pnpm run build
```

`typecheck` 检查前端与后端；`test` 运行 Vitest；`build` 生成 `dist/` 和 `scf/dist-server/`，不会嵌套调用 pnpm。仅编译服务端可用 `pnpm run build:server`。

自动化覆盖 AI 输出、日期、清单、输入上限、同步分批与并发、删除版本、COS 安全锁、CloudBase/PostgreSQL、提醒重试与定时维护。真实 AI 用例默认跳过，仅设置 `DEEPSEEK_LIVE_TEST=1` 时执行并调用配置的 Provider。默认测试使用本地 mock；真实 COS、AI 和 iPhone 推送链路需要单独验证。
