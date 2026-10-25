# 提醒定时服务部署

脚本只部署提醒 Worker；网页、任务数据和推送仍在现有服务。它不会自动登录、开通付费或创建测试通知。需要 Node.js 22+、Git，以及 Cloudflare 账户。所有命令均在仓库根目录执行。

1. 安装 Worker 独立依赖，并由你在浏览器完成 Cloudflare 授权：

   ```powershell
   npm --prefix cloudflare/reminder-alarm install
   node cloudflare/reminder-alarm/node_modules/wrangler/bin/wrangler.js login
   ```

2. 准备并部署：

   ```powershell
   node scripts/deploy-reminder-alarm.mjs prepare
   node scripts/deploy-reminder-alarm.mjs deploy
   ```

   `prepare` 在被 Git 忽略的 `.env.reminders.local` 里生成 32 字节随机密钥；重复运行复用密钥。`deploy` 使用项目固定的 Wrangler 版本、SQLite Durable Object 和回调地址 `https://ai-todo-pwa.netlify.app/api/reminders/deliver`。密钥经 stdin 传给 `wrangler secret put`，不会出现在参数或脚本输出中。成功后保存生产 `workers.dev` URL，并检查 `/health` 和认证后的 `/status`。若 Wrangler 成功输出没有地址，可加 `--worker-url https://ai-todo-reminder-alarm.<账户子域>.workers.dev`。

3. 把 `.env.reminders.local` 中的 `REMINDER_SCHEDULER_URL` 和 `REMINDER_SCHEDULER_SECRET` 配置到现有 Netlify 项目的 **Functions** 环境，发布含新提醒代码的版本。不要添加 `VITE_` 前缀，不要把此文件提交或发送到聊天。脚本不会读取 Netlify 登录令牌或修改计费；Netlify 额度暂停时，先等额度恢复或由账户所有者处理套餐。

4. 发布完成后，显式迁移已有提醒：

   ```powershell
   node scripts/deploy-reminder-alarm.mjs check
   node scripts/deploy-reminder-alarm.mjs bootstrap
   ```

   `check` 只读取健康和队列计数。`bootstrap` 使用相同密钥调用固定的 Netlify `/api/reminders/bootstrap`，可重复执行；它会登记已有提醒，已到期的真实提醒可能随后发送。不要在 Netlify 新代码和环境变量就绪前执行。此脚本不会替你提交事项或发送虚构通知。

所有命令都支持 `--dry-run`，只验证参数并显示步骤，不读取密钥、写文件、启动 Wrangler 或发起网络请求。`--help` 显示用法。密钥文件丢失时不要直接生成新密钥覆盖线上配置，应先恢复该文件，以免两端密钥不一致。

Wrangler 部署没有 `--json` 参数，因此脚本只解析成功输出中的本项目生产 URL，不把 CLI 原始输出转发到终端。参考：[部署与 secret put](https://developers.cloudflare.com/workers/wrangler/commands/workers/)、[登录](https://developers.cloudflare.com/workers/wrangler/commands/general/)。
