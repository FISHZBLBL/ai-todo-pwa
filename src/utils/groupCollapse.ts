export function toggleCollapsedGroup(collapsed: ReadonlySet<string>, groupKey: string): Set<string> {
  const next = new Set(collapsed)
  if (next.has(groupKey)) next.delete(groupKey)
  else next.add(groupKey)
  return next
}
