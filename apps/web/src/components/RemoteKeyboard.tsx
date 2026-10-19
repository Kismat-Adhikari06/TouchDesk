import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { RemoteControl } from '../hooks/useAgentStream'

interface RemoteKeyboardProps {
  open: boolean
  control: RemoteControl
  onClose: () => void
}

type Modifier = 'ctrl' | 'alt' | 'shift' | 'meta'

const MODIFIER_CODES: Record<Modifier, string> = {
  ctrl: 'ControlLeft',
  alt: 'AltLeft',
  shift: 'ShiftLeft',
  meta: 'MetaLeft',
}

const MODIFIER_LABELS: Record<Modifier, string> = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  meta: 'Meta',
}

const SPECIAL_KEYS: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'Backspace', label: '⌫' },
  { code: 'Enter', label: '⏎' },
  { code: 'Tab', label: '⇥' },
  { code: 'Escape', label: 'Esc' },
  { code: 'ArrowLeft', label: '←' },
  { code: 'ArrowUp', label: '↑' },
  { code: 'ArrowDown', label: '↓' },
  { code: 'ArrowRight', label: '→' },
  { code: 'Home', label: 'Home' },
  { code: 'End', label: 'End' },
]

function isModifierCode(code: string): boolean {
  return /^(Shift|Control|Alt|Meta)(Left|Right)$/.test(code)
}

function isSpecialCode(code: string): boolean {
  return SPECIAL_KEYS.some((key) => key.code === code)
}

/**
 * On-screen keyboard bridge: printable characters typed into the hidden
 * input are forwarded as text; special keys, shortcuts and the latched
 * modifiers travel as key events, matching what the agent replays.
 */
export default function RemoteKeyboard({ open, control, onClose }: RemoteKeyboardProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const latchedRef = useRef<Record<Modifier, boolean>>({
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  })
  const pressedRef = useRef<Set<string>>(new Set())
  const composingRef = useRef(false)
  const [latched, setLatched] = useState<Record<Modifier, boolean>>({
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  })

  const releaseModifiers = () => {
    for (const [modifier, wasLatched] of Object.entries(latchedRef.current)) {
      if (wasLatched) {
        control.sendKey(MODIFIER_CODES[modifier as Modifier], 'up')
      }
    }
    latchedRef.current = { ctrl: false, alt: false, shift: false, meta: false }
    setLatched({ ctrl: false, alt: false, shift: false, meta: false })
  }

  // Release everything whenever the keyboard closes or control turns off.
  useEffect(() => {
    if (open && control.enabled) return
    for (const code of pressedRef.current) {
      control.sendKey(code, 'up')
    }
    pressedRef.current.clear()
    releaseModifiers()
    // releaseModifiers intentionally omitted from deps: it reads live state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, control.enabled])

  // Focus the typing zone as a direct consequence of the toolbar click so
  // the phone's software keyboard opens.
  useEffect(() => {
    if (open && control.enabled) {
      const timer = window.setTimeout(() => inputRef.current?.focus(), 50)
      return () => window.clearTimeout(timer)
    }
  }, [open, control.enabled])

  if (!open || !control.enabled || !control.available) return null

  const toggleModifier = (modifier: Modifier) => {
    const wasLatched = latchedRef.current[modifier]
    if (wasLatched) {
      control.sendKey(MODIFIER_CODES[modifier], 'up')
    } else {
      control.sendKey(MODIFIER_CODES[modifier], 'down')
    }
    latchedRef.current = { ...latchedRef.current, [modifier]: !wasLatched }
    setLatched({ ...latchedRef.current })
    inputRef.current?.focus()
  }

  const comboActive = (event: ReactKeyboardEvent<HTMLInputElement>) =>
    latchedRef.current.ctrl ||
    latchedRef.current.alt ||
    latchedRef.current.meta ||
    latchedRef.current.shift ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey

  const sendKeyDown = (code: string) => {
    if (pressedRef.current.has(code)) return
    pressedRef.current.add(code)
    control.sendKey(code, 'down')
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (composingRef.current) return
    const { code } = event

    if (isModifierCode(code)) {
      event.preventDefault()
      if (!event.repeat) sendKeyDown(code)
      return
    }

    const combo = comboActive(event)

    if (combo) {
      // Shortcuts (Ctrl+C, Ctrl+Shift+T, …) must not reach the phone's UI.
      event.preventDefault()
      if (!event.repeat) sendKeyDown(code)
      return
    }

    if (isSpecialCode(code)) {
      event.preventDefault()
      if (!event.repeat) sendKeyDown(code)
      return
    }
    // Plain printable characters fall through to the input and leave as text.
  }

  const onKeyUp = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const { code } = event
    if (pressedRef.current.delete(code)) {
      control.sendKey(code, 'up')
    }
  }

  const onInput = () => {
    const input = inputRef.current
    if (!input || composingRef.current) return
    const value = input.value
    input.value = ''
    if (value) control.sendText(value)
  }

  const keyButtonClass =
    'rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 active:scale-[0.97]'

  return (
    <div className="stream-keyboard border-t border-slate-800 bg-slate-950/95 px-3 pb-2 pt-2">
      <div className="mb-2 flex items-center gap-1.5">
        {(['ctrl', 'alt', 'shift', 'meta'] as const).map((modifier) => (
          <button
            key={modifier}
            type="button"
            onClick={() => toggleModifier(modifier)}
            aria-pressed={latched[modifier]}
            className={`${keyButtonClass} ${latched[modifier] ? 'border-indigo-500 bg-indigo-600 text-white' : ''}`}
          >
            {MODIFIER_LABELS[modifier]}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-1.5 text-[10px] text-slate-500">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-indigo-400" />
          Typing goes to the computer
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close keyboard"
          className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-xs text-slate-400 transition hover:bg-slate-700 active:scale-[0.97]"
        >
          Hide
        </button>
      </div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {SPECIAL_KEYS.map((key) => (
          <button
            key={key.code}
            type="button"
            onClick={() => {
              control.sendKey(key.code, 'down')
              control.sendKey(key.code, 'up')
              inputRef.current?.focus()
            }}
            className={keyButtonClass}
          >
            {key.label}
          </button>
        ))}
      </div>
      <input
        ref={inputRef}
        type="text"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="done"
        aria-label="Type on the computer"
        placeholder="Type here — it appears on the computer…"
        className="w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-transparent caret-transparent outline-none placeholder:text-slate-600 focus:border-indigo-500"
        onInput={onInput}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onCompositionStart={() => {
          composingRef.current = true
        }}
        onCompositionEnd={(event) => {
          composingRef.current = false
          const value = event.currentTarget.value
          event.currentTarget.value = ''
          if (value) control.sendText(value)
        }}
      />
    </div>
  )
}
