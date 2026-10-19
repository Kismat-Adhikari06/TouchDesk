import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { RemoteControl } from './useAgentStream'

interface TouchPoint {
  x: number
  y: number
}

const TAP_SLOP = 10
const TAP_MAX_MS = 300
const DOUBLE_TAP_MS = 300
const LONG_PRESS_MS = 400
const TWO_FINGER_SLOP = 12

interface UseTouchControlOptions {
  control: RemoteControl
  enabled: boolean
  stageRef: RefObject<HTMLDivElement | null>
}

/**
 * Trackpad-style touch gestures for remote control:
 *  - one finger drag: move the remote cursor (scaled to the displayed video)
 *  - tap: left click, double tap: double click
 *  - long press: left-button drag
 *  - two finger tap: right click, two finger drag: scroll
 *
 * Listeners are attached natively with `{ passive: false }` because React's
 * root listeners are passive, which would let the page scroll while the
 * user is steering the remote cursor.
 */
export function useTouchControl({ control, enabled, stageRef }: UseTouchControlOptions) {
  const controlRef = useRef(control)
  useEffect(() => {
    controlRef.current = control
  }, [control])

  const state = useRef({
    fingerId: null as number | null,
    last: null as TouchPoint | null,
    moved: 0,
    startedAt: 0,
    longPressTimer: 0,
    dragging: false,
    lastTapAt: 0,
    twoFinger: false,
    twoFingerLastY: null as number | null,
    twoFingerMoved: 0,
    scrollDy: 0,
  })

  const clearLongPress = useCallback(() => {
    if (state.current.longPressTimer) {
      window.clearTimeout(state.current.longPressTimer)
      state.current.longPressTimer = 0
    }
  }, [])

  const scaleDelta = useCallback((dx: number, dy: number): { dx: number; dy: number } => {
    const stage = stageRef.current
    const { remoteWidth, remoteHeight } = controlRef.current
    if (!stage || remoteWidth <= 0 || remoteHeight <= 0) return { dx, dy }
    const video = stage.querySelector('video')
    const intrinsicW = video?.videoWidth || remoteWidth
    const intrinsicH = video?.videoHeight || remoteHeight
    const scale = Math.min(stage.clientWidth / intrinsicW, stage.clientHeight / intrinsicH)
    if (scale <= 0) return { dx, dy }
    return { dx: dx / scale, dy: dy / scale }
  }, [stageRef])

  const onTouchStart = useCallback(
    (event: TouchEvent) => {
      const control = controlRef.current
      if (!control.enabled) return
      const touches = Array.from(event.touches)

      if (touches.length >= 2 && !state.current.twoFinger) {
        // Second finger: cancel any pending tap or single-finger drag and
        // switch to the two-finger gesture.
        clearLongPress()
        if (state.current.dragging) {
          control.sendButton('left', 'up')
          state.current.dragging = false
        }
        state.current.twoFinger = true
        state.current.twoFingerMoved = 0
        state.current.scrollDy = 0
        state.current.twoFingerLastY = (touches[0].clientY + touches[1].clientY) / 2
        state.current.fingerId = null
        state.current.lastTapAt = 0
        return
      }
      if (state.current.twoFinger || state.current.fingerId !== null) return

      const touch = touches[0]
      state.current.fingerId = touch.identifier
      state.current.last = { x: touch.clientX, y: touch.clientY }
      state.current.moved = 0
      state.current.startedAt = performance.now()
      state.current.dragging = false

      state.current.longPressTimer = window.setTimeout(() => {
        if (
          state.current.fingerId !== null &&
          state.current.moved < TAP_SLOP &&
          !state.current.dragging &&
          !state.current.twoFinger
        ) {
          state.current.dragging = true
          controlRef.current.sendButton('left', 'down')
          navigator.vibrate?.(10)
        }
      }, LONG_PRESS_MS)
    },
    [clearLongPress],
  )

  const onTouchMove = useCallback(
    (event: TouchEvent) => {
      const control = controlRef.current
      if (!control.enabled) return

      if (state.current.twoFinger) {
        const touches = Array.from(event.touches)
        if (touches.length < 2 || state.current.twoFingerLastY === null) return
        const centerY = (touches[0].clientY + touches[1].clientY) / 2
        const deltaY = state.current.twoFingerLastY - centerY
        state.current.twoFingerLastY = centerY
        state.current.twoFingerMoved += Math.abs(deltaY)
        state.current.scrollDy += deltaY
        if (Math.abs(state.current.scrollDy) >= 4) {
          control.sendScroll(0, state.current.scrollDy)
          state.current.scrollDy = 0
        }
        event.preventDefault()
        return
      }

      const touch = Array.from(event.touches).find((t) => t.identifier === state.current.fingerId)
      if (!touch || !state.current.last) return

      const rawDx = touch.clientX - state.current.last.x
      const rawDy = touch.clientY - state.current.last.y
      state.current.last = { x: touch.clientX, y: touch.clientY }
      state.current.moved += Math.abs(rawDx) + Math.abs(rawDy)

      if (state.current.moved > TAP_SLOP) {
        clearLongPress()
      }
      if (state.current.moved > TWO_FINGER_SLOP * 2) state.current.lastTapAt = 0

      if (state.current.dragging || state.current.moved > TAP_SLOP) {
        const { dx, dy } = scaleDelta(rawDx, rawDy)
        control.sendMove(dx, dy)
      }
      event.preventDefault()
    },
    [clearLongPress, scaleDelta],
  )

  const onTouchEnd = useCallback(
    (event: TouchEvent) => {
      const control = controlRef.current
      if (state.current.twoFinger) {
        const remaining = Array.from(event.touches).length
        if (remaining > 0) return
        const quick = state.current.twoFingerMoved < TWO_FINGER_SLOP
        state.current.twoFinger = false
        state.current.twoFingerLastY = null
        state.current.scrollDy = 0
        if (quick && control.enabled) control.sendClick('right')
        return
      }

      const touch = Array.from(event.changedTouches).find(
        (t) => t.identifier === state.current.fingerId,
      )
      if (!touch) return

      clearLongPress()
      const duration = performance.now() - state.current.startedAt
      const isTap = state.current.moved < TAP_SLOP

      if (state.current.dragging) {
        control.sendButton('left', 'up')
        state.current.dragging = false
      } else if (isTap && duration < TAP_MAX_MS && control.enabled) {
        const now = performance.now()
        const isDouble = now - state.current.lastTapAt < DOUBLE_TAP_MS
        if (isDouble) {
          state.current.lastTapAt = 0
          control.sendClick('left', true)
        } else {
          state.current.lastTapAt = now
          control.sendClick('left')
        }
      }

      state.current.fingerId = null
      state.current.last = null
      state.current.moved = 0

      // If another finger is still down, treat it as a fresh single finger.
      const stillTouching = Array.from(event.touches)
      if (stillTouching.length === 1 && control.enabled) {
        const next = stillTouching[0]
        state.current.fingerId = next.identifier
        state.current.last = { x: next.clientX, y: next.clientY }
        state.current.moved = 0
        state.current.startedAt = performance.now()
        state.current.lastTapAt = 0
      }
    },
    [clearLongPress],
  )

  const onTouchCancel = useCallback(() => {
    clearLongPress()
    if (state.current.dragging) {
      controlRef.current.sendButton('left', 'up')
      state.current.dragging = false
    }
    state.current.fingerId = null
    state.current.last = null
    state.current.moved = 0
    state.current.twoFinger = false
    state.current.twoFingerLastY = null
    state.current.scrollDy = 0
    state.current.lastTapAt = 0
  }, [clearLongPress])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const options = { passive: false } as AddEventListenerOptions
    const start = (event: TouchEvent) => onTouchStart(event)
    const move = (event: TouchEvent) => onTouchMove(event)
    const end = (event: TouchEvent) => onTouchEnd(event)
    const cancel = () => onTouchCancel()
    stage.addEventListener('touchstart', start, options)
    stage.addEventListener('touchmove', move, options)
    stage.addEventListener('touchend', end, options)
    stage.addEventListener('touchcancel', cancel, options)
    return () => {
      stage.removeEventListener('touchstart', start)
      stage.removeEventListener('touchmove', move)
      stage.removeEventListener('touchend', end)
      stage.removeEventListener('touchcancel', cancel)
      onTouchCancel()
    }
  }, [enabled, stageRef, onTouchStart, onTouchMove, onTouchEnd, onTouchCancel])

  return { cancel: onTouchCancel }
}
