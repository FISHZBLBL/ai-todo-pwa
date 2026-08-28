import { createHash, createHmac, randomUUID } from 'node:crypto'

type PutOptions = { forbidOverwrite?: boolean }

const sha1 = (value: string) => createHash('sha1').update(value).digest('hex')
const hmacSha1 = (key: string, value: string) => createHmac('sha1', key).update(value).digest('hex')
const encodePath = (key: string) => key.split('/').map(part => encodeURIComponent(part)).join('/')

export class CosObjectStore {
  readonly owner = randomUUID()
  private readonly host: string

  constructor(
    private readonly bucket: string,
    private readonly region: string,
    private readonly secretId: string,
    private readonly secretKey: string
  ) {
    if (!bucket || bucket.includes('.cos.')) throw new Error('COS_BUCKET 必须是完整存储桶名称，例如 ai-todo-1250000000')
    if (!region || region.includes('.')) throw new Error('COS_REGION 必须是地域名称，例如 ap-shanghai')
    this.host = `${bucket}.cos.${region}.myqcloud.com`
  }

  async getText(key: string): Promise<string | null> {
    const response = await this.request('GET', key)
    if (response.status === 404) return null
    await this.assertOk(response, key)
    return response.text()
  }

  async putText(key: string, value: string, options: PutOptions = {}): Promise<boolean> {
    const headers = options.forbidOverwrite ? { 'x-cos-forbid-overwrite': 'true' } : undefined
    const response = await this.request('PUT', key, value, headers)
    if (options.forbidOverwrite && (response.status === 409 || response.status === 412)) return false
    await this.assertOk(response, key)
    return true
  }

  async delete(key: string): Promise<void> {
    const response = await this.request('DELETE', key)
    await this.assertOk(response, key)
  }

  private authorization(method: string, pathname: string, headers: Record<string, string>) {
    const now = Math.floor(Date.now() / 1000)
    const keyTime = `${now - 60};${now + 600}`
    const normalizedHeaders = Object.entries(headers)
      .map(([key, value]) => [key.toLowerCase(), value.trim()] as const)
      .sort(([a], [b]) => a.localeCompare(b))
    const headerList = normalizedHeaders.map(([key]) => key).join(';')
    const httpHeaders = normalizedHeaders.map(([key, value]) => `${encodeURIComponent(key).toLowerCase()}=${encodeURIComponent(value).toLowerCase()}`).join('&')
    const httpString = `${method.toLowerCase()}\n${pathname}\n\n${httpHeaders}\n`
    const signKey = hmacSha1(this.secretKey, keyTime)
    const signature = hmacSha1(signKey, `sha1\n${keyTime}\n${sha1(httpString)}\n`)
    return `q-sign-algorithm=sha1&q-ak=${this.secretId}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=${headerList}&q-url-param-list=&q-signature=${signature}`
  }

  private async request(method: 'GET' | 'PUT' | 'DELETE', key: string, body?: string, extraHeaders: Record<string, string> = {}) {
    const pathname = `/${encodePath(key)}`
    const signingHeaders = { host: this.host, ...extraHeaders }
    const headers = new Headers(extraHeaders)
    headers.set('Authorization', this.authorization(method, pathname, signingHeaders))
    headers.set('Host', this.host)
    if (body !== undefined) headers.set('Content-Type', 'application/json; charset=utf-8')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      return await fetch(`https://${this.host}${pathname}`, { method, headers, body, signal: controller.signal })
    } catch (error) {
      throw new Error(error instanceof Error && error.name === 'AbortError' ? '连接腾讯 COS 超时' : `连接腾讯 COS 失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      clearTimeout(timeout)
    }
  }

  private async assertOk(response: Response, key: string) {
    if (response.ok) return
    const requestId = response.headers.get('x-cos-request-id')
    const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200)
    throw new Error(`腾讯 COS 请求失败：${response.status}，对象 ${key}${requestId ? `，请求 ${requestId}` : ''}${detail ? `，${detail}` : ''}`)
  }
}
