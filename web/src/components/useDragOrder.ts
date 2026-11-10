import { useEffect, useRef } from 'react'

/*
 * Dragging the top bar's projects and worktrees into a different order.
 *
 * Pointer events rather than HTML drag-and-drop, which draws its own ghost,
 * fires no pointermove while it runs and knows nothing of a tab bar's rows.
 * A mouse only: on a touch screen the same gesture is how the bar is swiped,
 * and a drag that started on every swipe would be a bar you could not move
 * along.
 *
 * What may be dragged is said in the markup: an element with
 * `data-drag-item="<kind>"` and `data-drag-id` is a thing in the order, and
 * a `data-drag-handle` inside it is where it is picked up. It moves only
 * among its siblings of the same kind -- a worktree within its project -- and
 * only among those on screen: a tab the bar has given up is not somewhere
 * you can drop.
 */

/** How far the pointer goes before a press becomes a drag, so a click stays one. */
const THRESHOLD_PX = 5

export interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

/**
 * Where a drop at (x, y) lands among boxes in reading order: before or after
 * which one.
 *
 * By row first, because the heads wrap onto rows of their own on a phone-
 * width bar: the boxes on the pointer's row, or on the nearest one if it is
 * between rows; then the first of those whose middle is right of the
 * pointer, or after the last.
 */
export const dropAt = (boxes: readonly Box[], x: number, y: number): { index: number; after: boolean } | null => {
  if (boxes.length === 0) return null
  const distance = (box: Box): number => (y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0)
  const nearest = Math.min(...boxes.map(distance))
  const row = boxes.map((box, index) => ({ box, index })).filter(({ box }) => distance(box) === nearest)
  const before = row.find(({ box }) => x < (box.left + box.right) / 2)
  if (before !== undefined) return { index: before.index, after: false }
  return { index: row[row.length - 1]!.index, after: true }
}

/** `order` with `from` moved to beside `to`. Unchanged if either is missing or they are one. */
export const moveIn = (order: readonly string[], from: string, to: string, after: boolean): string[] => {
  if (from === to || !order.includes(from) || !order.includes(to)) return [...order]
  const rest = order.filter((id) => id !== from)
  const at = rest.indexOf(to) + (after ? 1 : 0)
  return [...rest.slice(0, at), from, ...rest.slice(at)]
}

export interface DragMove {
  kind: string
  from: string
  to: string
  after: boolean
  /** The id of the item the two sit in, if they sit in one: a worktree's project. */
  parent: string | null
}

export const useDragOrder = (
  root: React.RefObject<HTMLElement | null>,
  onMove: (move: DragMove) => void,
): void => {
  /*
   * Through a ref, so the listeners are set up once: a snapshot landing
   * mid-drag re-renders the bar with a new callback, and re-subscribing then
   * would end the drag under the pointer.
   */
  const moved = useRef(onMove)
  moved.current = onMove
  useEffect(() => {
    const host = root.current
    if (!host) return
    let press: { item: HTMLElement; x: number; y: number; pointer: number } | null = null
    let dragging = false
    let target: { item: HTMLElement; after: boolean } | null = null

    const siblings = (item: HTMLElement): HTMLElement[] =>
      [...(item.parentElement?.children ?? [])].filter(
        (one): one is HTMLElement =>
          one instanceof HTMLElement &&
          one.dataset.dragItem === item.dataset.dragItem &&
          // On screen: a tab the bar has given up has no box to drop beside.
          one.offsetParent !== null,
      )

    const mark = (next: typeof target): void => {
      target?.item.removeAttribute('data-drop')
      target = next
      target?.item.setAttribute('data-drop', target.after ? 'after' : 'before')
    }

    const end = (): void => {
      press?.item.removeAttribute('data-dragging')
      press?.item.style.removeProperty('transform')
      mark(null)
      document.documentElement.removeAttribute('data-dragging')
      press = null
      dragging = false
    }

    const down = (event: PointerEvent): void => {
      if (event.pointerType !== 'mouse' || event.button !== 0) return
      const handle = (event.target as HTMLElement).closest<HTMLElement>('[data-drag-handle]')
      const item = handle?.closest<HTMLElement>('[data-drag-item]')
      if (!handle || !item || !host.contains(item)) return
      press = { item, x: event.clientX, y: event.clientY, pointer: event.pointerId }
    }

    const move = (event: PointerEvent): void => {
      if (press === null || event.pointerId !== press.pointer) return
      if (!dragging) {
        if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < THRESHOLD_PX) return
        dragging = true
        press.item.setAttribute('data-dragging', '')
        // The cursor says so everywhere, not only over the tabs.
        document.documentElement.setAttribute('data-dragging', '')
      }
      /*
       * It follows the pointer, so you see what you are holding: measured as
       * missing, a drag whose only sign was a dimmed tab and a marker at the
       * far end read as nothing happening. A transform, so nothing in the bar
       * reflows under it. Its own box, which now rides under the pointer, is
       * left out of where it could land: measured among the others alone.
       */
      press.item.style.transform = `translate(${event.clientX - press.x}px, ${event.clientY - press.y}px)`
      const held = press.item
      const items = siblings(held).filter((one) => one !== held)
      const drop = dropAt(
        items.map((one) => one.getBoundingClientRect()),
        event.clientX,
        event.clientY,
      )
      const over = drop === null ? undefined : items[drop.index]
      mark(over === undefined || drop === null ? null : { item: over, after: drop.after })
    }

    const up = (event: PointerEvent): void => {
      if (press === null || event.pointerId !== press.pointer) return
      if (dragging) {
        /*
         * The click that follows the release would open the tab you dropped,
         * so it is swallowed -- once, and only if it comes at once.
         */
        const swallow = (click: MouseEvent): void => {
          click.stopPropagation()
          click.preventDefault()
        }
        window.addEventListener('click', swallow, { capture: true, once: true })
        window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
        if (target !== null) {
          const parent = press.item.parentElement?.closest<HTMLElement>('[data-drag-item]')
          moved.current({
            kind: press.item.dataset.dragItem ?? '',
            from: press.item.dataset.dragId ?? '',
            to: target.item.dataset.dragId ?? '',
            after: target.after,
            parent: parent?.dataset.dragId ?? null,
          })
        }
      }
      end()
    }

    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && dragging) end()
    }

    host.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', end)
    window.addEventListener('keydown', key)
    return () => {
      end()
      host.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', end)
      window.removeEventListener('keydown', key)
    }
  }, [root])
}
