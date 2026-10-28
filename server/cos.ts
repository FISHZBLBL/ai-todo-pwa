import { createHash, createHmac } from 'node:crypto'

type PutOptions = { forbidOverwrite?: boolean }

const sha1 = (value: string) => createHash('sha1').update(value).digest('hex')
const hmacSha1 = (key: string, value: string) => createHmac('sha1', key).update(value).digest('hex')
const encodePath = (key: string) => key.split('/').map(part => encodeURIComponent(part)).join('/')

export class CosOperationError extends Error {
  constructor(
    readonly operation: 'object-read' | 'object-write' | 'object-delete' | 'bucket-versioning',
    readonly httpStatus: number,
    readonly serviceCode: string | null,
  ) {
    super(`腾讯 COS 请求失败：HTTP ${httpStatus}`)
    this.name = 'CosOperationError'
  }
}

export class CosObjectStore {
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
    await this.assertOk(response, 'object-read')
    return response.text()
  }

  async putText(key: string, value: string, options: PutOptions = {}): Promise<boolean> {
    const headers = options.forbidOverwrite ? { 'x-cos-forbid-overwrite': 'true' } : undefined
    const response = await this.request('PUT', key, value, headers)
    if (options.forbidOverwrite && (response.status === 409 || response.status === 412)) return false
    await this.assertOk(response, 'object-write')
    return true
  }

  async delete(key: string): Promise<void> {
    const response = await this.request('DELETE', key)
    await this.assertOk(response, 'object-delete')
  }

  // https://cloud.tencent.com/document/product/436/7749 documents
  // forbid-overwrite, not destination PUT If-Match. Locking additionally requires
  // never-enabled versioning: https://cloud.tencent.com/document/api/436/19888.
  async assertSafeLocking(): Promise<void> {
    const response = await this.request('GET', '', undefined, {}, { versioning: '' })
    await this.assertOk(response, 'bucket-versioning')
    const xml = await response.text()
    if (/<Status(?:\s[^>]*)?(?:>|\/>)/.test(xml)) throw new Error('COS 安全写入需要从未开启版本控制的存储桶；请改用支持事务的 cloudbase 存储')
    const root = xml.replace(/^\s*<\?xml[^>]*>\s*/, '').trim()
    if (!/^<VersioningConfiguration(?:\s[^>]*)?\s*(?:\/>|>\s*<\/VersioningConfiguration>)$/.test(root)) throw new Error('无法确认 COS 存储桶的版本控制状态，已停止写入')
  }

  private authorization(method: string, pathname: string, headers: Record<string, string>, query: Record<string, string>) {
    const now = Math.floor(Date.now() / 1000)
    const keyTime = `${now - 60};${now + 600}`
    const normalizedHeaders = Object.entries(headers)
      .map(([key, value]) => [key.toLowerCase(), value.trim()] as const)
      .sort(([a], [b]) => a.localeCompare(b))
    const headerList = normalizedHeaders.map(([key]) => key).join(';')
    const httpHeaders = normalizedHeaders.map(([key, value]) => `${encodeURIComponent(key).toLowerCase()}=${encodeURIComponent(value).toLowerCase()}`).join('&')
    const normalizedQuery = Object.entries(query).sort(([a], [b]) => a.localeCompare(b))
    const queryList = normalizedQuery.map(([key]) => key.toLowerCase()).join(';')
    const httpQuery = normalizedQuery.map(([key, value]) => `${encodeURIComponent(key).toLowerCase()}=${encodeURIComponent(value)}`).join('&')
    const httpString = `${method.toLowerCase()}\n${pathname}\n${httpQuery}\n${httpHeaders}\n`
    const signKey = hmacSha1(this.secretKey, keyTime)
    const signature = hmacSha1(signKey, `sha1\n${keyTime}\n${sha1(httpString)}\n`)
    return `q-sign-algorithm=sha1&q-ak=${this.secretId}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=${headerList}&q-url-param-list=${queryList}&q-signature=${signature}`
  }

  private async request(method: 'GET' | 'PUT' | 'DELETE', key: string, body?: string, extraHeaders: Record<string, string> = {}, query: Record<string, string> = {}) {
    const pathname = `/${encodePath(key)}`
    const signingHeaders = { host: this.host, ...extraHeaders }
    const headers = new Headers(extraHeaders)
    headers.set('Authorization', this.authorization(method, pathname, signingHeaders, query))
    headers.set('Host', this.host)
    if (body !== undefined) headers.set('Content-Type', 'application/json; charset=utf-8')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      const search = new URLSearchParams(query).toString()
      return await fetch(`https://${this.host}${pathname}${search ? `?${search}` : ''}`, { method, headers, body, signal: controller.signal })
    } catch (error) {
      throw new Error(error instanceof Error && error.name === 'AbortError' ? '连接腾讯 COS 超时' : `连接腾讯 COS 失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      clearTimeout(timeout)
    }
  }

  private async assertOk(response: Response, operation: CosOperationError['operation']) {
    if (response.ok) return
    const xml = await response.text().catch(() => '')
    const code = /<Code>([^<]*)<\/Code>/.exec(xml)?.[1]
    const serviceCode = code && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.exec(code)?.[0] === code ? code : null
    throw new CosOperationError(operation, response.status, serviceCode)
  }
}
