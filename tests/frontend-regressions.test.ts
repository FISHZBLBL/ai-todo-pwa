import { afterEach, describe, expect, it, vi } from 'vitest'
import * as checklist from '../src/utils/checklist'
import * as date from '../src/utils/date'
import * as reminder from '../src/utils/reminder'
import * as reminderPreview from '../src/ai/reminderPreview'
import * as inboxValidation from '../src/ai/inboxValidation'
import * as localParser from '../src/ai/localParser'
import * as homeGroups from '../src/utils/homeGroups'
import * as groupCollapse from '../src/utils/groupCollapse'
import { taskRepository } from '../src/repositories/taskRepository'
import { draftRepository } from '../src/repositories/draftRepository'
import { profileRepository } from '../src/repositories/profileRepository'
import { db, getSettings, resetDatabaseForTests, saveSettings } from '../src/storage/database'
import { flushPromises, mountSfc } from './helpers/mountSfc'
import type { Draft, ParsedTask, Task } from '../src/types'

const createdAt = '2026-09-25T00:00:00.000Z'
const task: Task = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kind: 'checklist', title: '出行', dueDate: null, dateRange: null, reminders: [], reminderMode: 'off', pinned: false, completed: false, createdAt, updatedAt: createdAt, source: 'manual', checklist: { sections: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: '衣物', items: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', text: '外套', completed: false }] }] } }
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.useRealTimers(); vi.restoreAllMocks() })

describe('前端已报告问题的真实组件回归', () => {
  it('编辑清单拖动空白项时不会提前持久化未保存内容', async () => {
    const update = vi.fn()
    const mounted = mountSfc('src/views/ChecklistView.vue', { '../utils/checklist': checklist }, { task, onUpdate: update }, ['editing', 'content', 'addItem', 'endDrag', 'finishEditing'])
    cleanups.push(mounted.unmount)
    mounted.vm.editing = true
    mounted.vm.addItem(mounted.vm.content.sections[0])
    mounted.vm.endDrag()
    expect(update).not.toHaveBeenCalled()
    mounted.vm.content.sections[0].items[1].text = '雨衣'
    mounted.vm.finishEditing()
    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0][0].checklist.sections[0].items.map((item: { text: string }) => item.text)).toEqual(['外套', '雨衣'])
  })

  it('范围任务选择无日期后保存会清空 dateRange', async () => {
    const save = vi.fn()
    const mounted = mountSfc('src/components/TaskEditor.vue', { '../utils/date': date, '../utils/reminder': reminder, '../storage/database': { getSettings: async () => ({ dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' }) } }, { task: { ...task, kind: 'task', checklist: null, dateRange: { start: '2026-10-05', end: '2026-10-09' } }, onSave: save }, ['quickDate', 'save'])
    cleanups.push(mounted.unmount)
    mounted.vm.quickDate(null)
    mounted.vm.save()
    expect(save.mock.calls[0][0].dateRange).toBeNull()
  })

  it('离开 AI 页面会取消旧请求，旧返回不能再保存草稿', async () => {
    let resolveParse!: (value: { tasks: ParsedTask[] }) => void
    const parse = vi.fn((_content: string, _time: string, _signal: AbortSignal) => new Promise<{ tasks: ParsedTask[] }>(resolve => { resolveParse = resolve }))
    const save = vi.fn(async (value: Draft) => value)
    const mounted = aiComponent(parse, save)
    cleanups.push(mounted.unmount)
    await flushPromises()
    mounted.vm.content = '明天买雨衣'
    const operation = mounted.vm.parse()
    await flushPromises()
    const beforeUnmount = save.mock.calls.length
    mounted.unmount(); cleanups.pop()
    expect(parse.mock.calls[0][2].aborted).toBe(true)
    resolveParse({ tasks: [] })
    await operation
    expect(save).toHaveBeenCalledTimes(beforeUnmount)
  })

  it('确认本地预览会等待已有草稿写入完成后才删除草稿', async () => {
    let releaseSave!: () => void
    const confirm = vi.fn()
    const save = vi.fn((value: Draft) => new Promise<Draft>(resolve => { releaseSave = () => resolve(value) }))
    const mounted = aiComponent(vi.fn(), save, confirm)
    cleanups.push(mounted.unmount)
    await flushPromises()
    mounted.vm.content = '明天买雨衣'
    const pendingSave = mounted.vm.saveDraft()
    await flushPromises()
    mounted.vm.localPreview()
    const pendingConfirm = mounted.vm.confirm()
    await flushPromises()
    expect(confirm).not.toHaveBeenCalled()
    releaseSave()
    await pendingSave; await pendingConfirm
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('首次自动保存前确认也会先持久化草稿，并传递可原子消费的草稿 ID', async () => {
    const confirm = vi.fn()
    const save = vi.fn(async (value: Draft) => value)
    const mounted = aiComponent(vi.fn(), save, confirm)
    cleanups.push(mounted.unmount)
    await flushPromises()
    mounted.vm.content = '明天买雨衣'
    mounted.vm.localPreview()
    await mounted.vm.confirm()
    expect(save).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][1]).toBe(save.mock.calls[0][0].id)
  })

  it('卸载 AI 页面会清理尚未执行的自动保存定时器', async () => {
    vi.useFakeTimers()
    const save = vi.fn(async (value: Draft) => value)
    const mounted = aiComponent(vi.fn(), save)
    await flushPromises()
    mounted.vm.content = '一条新想法'
    await flushPromises()
    mounted.unmount()
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).not.toHaveBeenCalled()
  })

  it('超长 AI 输入不会写入草稿或发出解析请求', async () => {
    const parse = vi.fn()
    const save = vi.fn(async (value: Draft) => value)
    const mounted = aiComponent(parse, save)
    cleanups.push(mounted.unmount)
    await flushPromises()
    mounted.vm.content = '字'.repeat(10001)
    await mounted.vm.saveDraft()
    await mounted.vm.parse()
    expect(save).not.toHaveBeenCalled()
    expect(parse).not.toHaveBeenCalled()
    expect(mounted.container.textContent).toContain('最多 10000 字')
  })

  it('清单创建器限制为 30 个分组、每组 200 项', async () => {
    const mounted = mountSfc('src/components/ChecklistEditor.vue', { '../utils/checklist': checklist }, {}, ['sections', 'addSection', 'addItem'])
    cleanups.push(mounted.unmount)
    mounted.vm.sections = Array.from({ length: 30 }, (_, index) => ({ id: `section-${index}`, title: '分组', note: null, items: [] }))
    mounted.vm.addSection()
    expect(mounted.vm.sections).toHaveLength(30)
    const section = mounted.vm.sections[0]
    section.items = Array.from({ length: 200 }, (_, index) => ({ id: `item-${index}`, text: '物品', completed: false }))
    mounted.vm.addItem(section)
    expect(section.items).toHaveLength(200)
  })

  it('超过 500 字的清单项目保留在编辑中并显示错误，不会进入同步', async () => {
    const update = vi.fn()
    const mounted = mountSfc('src/views/ChecklistView.vue', { '../utils/checklist': checklist }, { task, onUpdate: update }, ['editing', 'content', 'finishEditing'])
    cleanups.push(mounted.unmount)
    mounted.vm.editing = true
    mounted.vm.content.sections[0].items[0].text = '字'.repeat(501)
    mounted.vm.finishEditing()
    await flushPromises()
    expect(update).not.toHaveBeenCalled()
    expect(mounted.vm.editing).toBe(true)
    expect(mounted.container.textContent).toContain('每个清单项最多 500 字')
  })

  it('新设备启动不会把默认 08:00 当作新设置入队', async () => {
    await resetDatabaseForTests()
    const mounted = appComponent()
    cleanups.push(mounted.unmount)
    await mounted.ready
    expect((await getSettings()).updatedAt).toBe(new Date(0).toISOString())
    expect(await (await db()).count('syncQueue')).toBe(0)
  })

  it('设备当前时区不会在启动时覆盖云端账户的时区与汇总时间', async () => {
    await resetDatabaseForTests()
    await saveSettings({ id: 'settings', dailySummaryTime: '09:30', timezone: 'America/New_York', schemaVersion: 3, updatedAt: createdAt })
    const mounted = appComponent()
    cleanups.push(mounted.unmount)
    await mounted.ready
    expect(await getSettings()).toMatchObject({ dailySummaryTime: '09:30', timezone: 'America/New_York', updatedAt: createdAt })
    expect(await (await db()).count('syncQueue')).toBe(0)
  })
})

function aiComponent(parse: unknown, save: unknown, onConfirm = vi.fn()) {
  return mountSfc('src/views/AIInboxView.vue', {
    '../repositories/draftRepository': { draftRepository: { latest: async () => undefined, get: async () => undefined, save } },
    '../services/api': { api: { parse } },
    '../utils/date': date,
    '../ai/localParser': localParser,
    '../ai/reminderPreview': reminderPreview,
    '../ai/inboxValidation': inboxValidation,
    '../storage/database': { getSettings: async () => ({ dailySummaryTime: '08:00' }) },
    '../composables/useSpeech': { useSpeech: () => ({ supported: false }) }
  }, { onConfirm }, ['content', 'parse', 'localPreview', 'saveDraft', 'confirm'])
}

function appComponent() {
  let markReady!: () => void
  const ready = new Promise<void>(resolve => { markReady = resolve })
  const mounted = mountSfc('src/App.vue', {
    './stores/tasks': { useTaskStore: () => ({ tasks: [], sorted: [], active: [], completed: [], load: async () => undefined }) },
    './stores/profiles': { useProfileStore: () => ({ load: async () => undefined }) },
    './utils/date': date,
    './sync/syncService': { installAutoSync: () => { markReady(); return () => undefined }, syncNow: vi.fn() },
    './repositories/taskRepository': { taskRepository },
    './repositories/draftRepository': { draftRepository },
    './repositories/profileRepository': { profileRepository },
    './services/api': { api: { hasSession: () => false }, authExpiredEvent: 'auth-expired-test' },
    './utils/swipeCoordinator': { requestCloseSwipeActions: () => undefined },
    './utils/groupCollapse': groupCollapse,
    './utils/homeGroups': homeGroups,
    './utils/checklist': checklist
  })
  return { ...mounted, ready }
}
