export type SwipeReveal = 'complete' | 'delete' | null

export function resolveSwipeReveal(deltaX: number, deltaY: number, canComplete = true): SwipeReveal {
  if (Math.abs(deltaX) < 52 || Math.abs(deltaX) < Math.abs(deltaY) * 1.3) return null
  if (deltaX > 0) return canComplete ? 'complete' : null
  return 'delete'
}
