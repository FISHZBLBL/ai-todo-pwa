import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import * as Vue from 'vue'
import * as limits from '../../shared/limits'

/** Compile the real SFC in tests without changing the production Vite config. */
export function mountSfc(file: string, modules: Record<string, unknown>, props: Record<string, unknown> = {}, expose: string[] = []) {
  const source = readFileSync(resolve(file), 'utf8').replace('</script>', `defineExpose({ ${expose.join(', ')} })\n</script>`)
  const script = compileScript(parse(source, { filename: file }).descriptor, { id: `test-${file}`, inlineTemplate: true })
  const code = ts.transpileModule(script.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
  const exports: { default?: Vue.Component } = {}
  const icon = Vue.defineComponent({ render: () => Vue.h('span') })
  const bottomSheet = Vue.defineComponent({ setup: (_props, { slots }) => () => Vue.h('div', slots.default?.()) })
  const require = (name: string) => {
    if (name === 'vue') return Vue
    if (name.endsWith('/shared/limits')) return limits
    if (name === '@lucide/vue') return new Proxy({}, { get: () => icon })
    if (name.endsWith('BottomSheet.vue')) return { __esModule: true, default: bottomSheet }
    if (name.endsWith('.vue')) return { __esModule: true, default: icon }
    if (name in modules) return modules[name]
    throw new Error(`Missing SFC dependency: ${name}`)
  }
  new Function('require', 'exports', code)(require, exports)
  const container = document.createElement('div')
  document.body.append(container)
  const app = Vue.createApp(exports.default!, props)
  const vm = app.mount(container) as unknown as Record<string, any>
  return { vm, container, unmount: () => { app.unmount(); container.remove() } }
}

export async function flushPromises() {
  for (let index = 0; index < 8; index++) await Promise.resolve()
  await Vue.nextTick()
}
