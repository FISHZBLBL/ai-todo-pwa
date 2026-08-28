export const closeSwipeEvent = 'todo:close-swipe-actions'

export function requestCloseSwipeActions(exceptTaskId?: string) {
  window.dispatchEvent(new CustomEvent<string | undefined>(closeSwipeEvent, { detail: exceptTaskId }))
}

export function listenForSwipeClose(taskId: string, close: () => void) {
  const listener = (event: Event) => {
    const exceptTaskId = (event as CustomEvent<string | undefined>).detail
    if (exceptTaskId !== taskId) close()
  }
  window.addEventListener(closeSwipeEvent, listener)
  return () => window.removeEventListener(closeSwipeEvent, listener)
}
