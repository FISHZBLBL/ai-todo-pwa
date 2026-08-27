export function extractFirstUrl(text: string): string | null {
  return text.match(/https?:\/\/[^\s，,。；;]+/)?.[0] ?? null
}
