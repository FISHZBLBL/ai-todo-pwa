import { z } from 'zod'

const schema = z.object({
  PORT: z.coerce.number().default(8787),
  PASSWORD_HASH: z.string().min(20).default('$2b$12$invalid.configure.PASSWORD_HASH.before.production'),
  JWT_SECRET: z.string().min(24).default('development-only-change-this-secret'),
  AI_PROVIDER: z.string().default('openai-compatible'),
  AI_API_KEY: z.string().optional(),
  AI_BASE_URL: z.string().url().default('https://api.deepseek.com'),
  AI_MODEL: z.string().default('deepseek-chat'),
  DATA_FILE: z.string().default('./data/todo.json'),
  STORAGE_ADAPTER: z.enum(['file', 'cloudbase', 'cloudbase-storage', 'cloudbase-postgres', 'cos']).default('file'),
  CLOUDBASE_ENV_ID: z.string().optional(),
  CLOUDBASE_APIKEY: z.string().optional(),
  CLOUDBASE_REGION: z.string().default('ap-shanghai'),
  CLOUDBASE_COLLECTION: z.string().default('ai_todo_state'),
  CLOUDBASE_DOCUMENT_ID: z.string().default('single-user-state'),
  CLOUDBASE_STATE_PATH: z.string().default('ai-todo/state.json'),
  COS_BUCKET: z.string().optional(),
  COS_REGION: z.string().default('ap-shanghai'),
  COS_SECRET_ID: z.string().optional(),
  COS_SECRET_KEY: z.string().optional(),
  COS_STATE_KEY: z.string().default('ai-todo/state.json'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:admin@example.com'),
  APP_TIMEZONE: z.string().default('Asia/Shanghai')
})
export const config = schema.parse(process.env)
if (process.env.NODE_ENV === 'production' || process.env.SCF_RUNTIME) {
  if (config.PASSWORD_HASH.includes('invalid.configure')) throw new Error('生产环境必须配置 PASSWORD_HASH')
  if (config.JWT_SECRET === 'development-only-change-this-secret') throw new Error('生产环境必须配置 JWT_SECRET')
  if (['cloudbase', 'cloudbase-storage', 'cloudbase-postgres'].includes(config.STORAGE_ADAPTER) && !config.CLOUDBASE_ENV_ID) throw new Error('CloudBase 存储必须配置 CLOUDBASE_ENV_ID')
  if (config.STORAGE_ADAPTER === 'cloudbase-postgres' && !config.CLOUDBASE_APIKEY) throw new Error('CloudBase PostgreSQL 存储必须配置 CLOUDBASE_APIKEY')
  if (config.STORAGE_ADAPTER === 'cos' && (!config.COS_BUCKET || !config.COS_SECRET_ID || !config.COS_SECRET_KEY)) throw new Error('COS 存储必须配置 COS_BUCKET、COS_SECRET_ID 和 COS_SECRET_KEY')
}
