import { describe, expect, it, vi } from 'vitest'
import { checklistProgress, cloneChecklist, parsedChecklistContent } from '../src/utils/checklist'

describe('checklist helpers', () => {
  it('counts completed items without moving or removing them', () => {
    const checklist = { sections: [{ id: 'section', title: '衣物', note: null, items: [{ id: 'a', text: '雨壳', completed: true }, { id: 'b', text: '手套', completed: false }] }] }
    expect(checklistProgress({ checklist })).toEqual({ completed: 1, total: 2 })
    expect(checklist.sections[0].items.map(item => item.text)).toEqual(['雨壳', '手套'])
  })

  it('turns an AI checklist into stable local ids and excludes unchecked preview rows', () => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn().mockReturnValueOnce('section-id').mockReturnValueOnce('item-id') })
    const checklist = parsedChecklistContent({ kind: 'checklist', title: '四川旅行', sections: [{ title: '衣物', note: '现有鞋够用', items: [{ text: '雨壳' }, { text: '重复购买鞋', selected: false }] }] })
    expect(checklist).toEqual({ sections: [{ id: 'section-id', title: '衣物', note: '现有鞋够用', items: [{ id: 'item-id', text: '雨壳', completed: false, completedAt: null }] }] })
    vi.unstubAllGlobals()
  })

  it('deep clones sections and items before repository persistence', () => {
    const source = { sections: [{ id: 'section', title: '摄影', items: [{ id: 'item', text: '相机', completed: false }] }] }
    const copy = cloneChecklist(source)!
    copy.sections[0].items[0].completed = true
    expect(source.sections[0].items[0].completed).toBe(false)
  })
})
