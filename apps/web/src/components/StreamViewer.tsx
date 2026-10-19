import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { RemoteControl, StreamStatus } from '../hooks/useAgentStream'
import { useTouchControl } from '../hooks/useTouchControl'
import RemoteKeyboard from './RemoteKeyboard'

interface StreamViewerProps {
  videoRef: RefObject<HTMLVideoElement | null>
  status: StreamStatus
  agentState: string | null
  control: RemoteControl
  onDisconnect: () => void
}

type FullscreenCapableVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void
  webkitExitFullscreen?: () => void
  requestVideoFrameCallback?: (callback: () => void) => number
}

type FullscreenCapableElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void
}

type FullscreenCapableDocument = Document & {
  webkitFullscreenEnabled?: boolean
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => Promise<void> | void
}

function Spinner() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-7 animate-spin text-indigo-400" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

function ExpandIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={className} fill="none">
      <path
        d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CollapseIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={className} fill="none">
      <path
        d="M4 9h5V4M20 9h-5v5M4 15h5v5M20 15h-5v-5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function MouseIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={className} fill="none">
      <rect x="7" y="3" width="10" height="18" rx="5" stroke="currentColor" strokeWidth="2" />
      <path d="M12 7v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function KeyboardIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={className} fill="none">
      <rect x="2" y="6" width="20" height="12" rx="2" stroke="currentColor" strokeWidth="2" />
      <path
        d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h12"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}

export default function StreamViewer({
  videoRef,
  status,
  agentState,
  control,
  onDisconnect,
}: StreamViewerProps) {
  const shellRef = useRef<HTMLElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [hasFrames, setHasFrames] = useState(false)
  const [fullscreenBlocked, setFullscreenBlocked] = useState(false)
  const [mode, setMode] = useState<'view' | 'mouse' | 'keyboard'>('view')

  // Reset frame detection and control mode whenever the connection status
  // changes (new session).
  const [prevStatus, setPrevStatus] = useState(status)
  if (prevStatus !== status) {
    setPrevStatus(status)
    setHasFrames(false)
    setMode('view')
  }

  // Follow external authorization changes (data channel closed, agent
  // refused control) instead of keeping a stale local mode.
  const [prevControlEnabled, setPrevControlEnabled] = useState(control.enabled)
  if (prevControlEnabled !== control.enabled) {
    setPrevControlEnabled(control.enabled)
    if (!control.enabled) setMode('view')
  }

  const touchActive = control.enabled && status === 'live'
  const { cancel: cancelGestures } = useTouchControl({
    control,
    enabled: touchActive,
    stageRef,
  })

  const toggleMouse = () => {
    if (mode === 'mouse') {
      setMode('view')
      control.setEnabled(false)
    } else {
      cancelGestures()
      setMode('mouse')
      control.setEnabled(true)
    }
  }

  const toggleKeyboard = () => {
    if (mode === 'keyboard') {
      setMode('mouse')
      return
    }
    cancelGestures()
    setMode('keyboard')
    control.setEnabled(true)
  }

  // "capturing" only means the portal was approved — the approval hint must
  // show until then, and must vanish once frames actually render.
  const approvalNeeded =
    status === 'live' && agentState !== 'capturing' && agentState !== 'disconnected' && !hasFrames
  const starting = status === 'live' && agentState === 'capturing' && !hasFrames
  const showInterrupted = status === 'live' && agentState === 'disconnected'
  const showNegotiating = status === 'connecting'

  useEffect(() => {
    const doc = document as FullscreenCapableDocument
    const video = videoRef.current as FullscreenCapableVideo | null
    const sync = () => {
      setIsFullscreen(Boolean(document.fullscreenElement || doc.webkitFullscreenElement))
    }
    const onNativeEnter = () => setIsFullscreen(true)
    const onNativeExit = () => setIsFullscreen(false)
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
    // iOS Safari presents video fullscreen through its own player.
    video?.addEventListener('webkitbeginfullscreen', onNativeEnter)
    video?.addEventListener('webkitendfullscreen', onNativeExit)
    sync()
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      document.removeEventListener('webkitfullscreenchange', sync)
      video?.removeEventListener('webkitbeginfullscreen', onNativeEnter)
      video?.removeEventListener('webkitendfullscreen', onNativeExit)
    }
  }, [videoRef])

  useEffect(() => {
    if (!isFullscreen) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [isFullscreen])

  useEffect(() => {
    if (status !== 'live') return
    const video = videoRef.current as FullscreenCapableVideo | null
    if (!video) return
    let active = true
    if (typeof video.requestVideoFrameCallback === 'function') {
      const check = () => {
        if (!active) return
        if (video.videoWidth > 0) {
          setHasFrames(true)
          return
        }
        video.requestVideoFrameCallback?.(check)
      }
      video.requestVideoFrameCallback(check)
      return () => {
        active = false
      }
    }
    const interval = window.setInterval(() => {
      if (video.videoWidth > 0 && video.currentTime > 0) {
        setHasFrames(true)
        window.clearInterval(interval)
      }
    }, 400)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [status, videoRef])

  const toggleFullscreen = useCallback(async () => {
    const doc = document as FullscreenCapableDocument
    const video = videoRef.current as FullscreenCapableVideo | null
    const shell = shellRef.current as FullscreenCapableElement | null
    try {
      if (isFullscreen) {
        if (document.fullscreenElement && document.exitFullscreen) {
          await document.exitFullscreen()
        } else if (doc.webkitFullscreenElement && doc.webkitExitFullscreen) {
          await doc.webkitExitFullscreen()
        } else {
          video?.webkitExitFullscreen?.()
        }
        return
      }
      if (shell) {
        if (typeof shell.requestFullscreen === 'function') {
          await shell.requestFullscreen({ navigationUI: 'hide' })
          try {
            void screen.orientation?.lock?.('landscape')?.catch?.(() => {})
          } catch {
            // Orientation lock is optional and widely unsupported.
          }
          return
        }
        if (shell.webkitRequestFullscreen) {
          shell.webkitRequestFullscreen()
          return
        }
      }
      if (video?.webkitEnterFullscreen) {
        video.webkitEnterFullscreen()
        return
      }
      setFullscreenBlocked(true)
    } catch {
      // Element fullscreen was refused — try the native video player once.
      try {
        if (video?.webkitEnterFullscreen && !document.fullscreenElement) {
          video.webkitEnterFullscreen()
          return
        }
      } catch {
        // Fall through to blocked.
      }
      setFullscreenBlocked(true)
    }
  }, [isFullscreen, videoRef])

  // Shown until a fullscreen attempt fails (restricted browser/iframe), then hidden.
  const showFsButton = !fullscreenBlocked
  const footerDot = approvalNeeded
    ? 'bg-amber-400'
    : starting
      ? 'bg-indigo-400'
      : 'bg-emerald-400'
  const footerLabel = approvalNeeded
    ? 'Waiting for approval…'
    : starting
      ? 'Starting the stream…'
      : 'Live view'

  return (
    <section
      ref={shellRef}
      className="stream-shell w-full max-w-3xl overflow-hidden rounded-2xl border border-slate-800 bg-slate-900"
    >
      <div
        ref={stageRef}
        className={`stream-stage relative aspect-video w-full bg-black ${touchActive ? 'touch-none select-none' : ''}`}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="size-full object-contain"
        />
        {showNegotiating && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-950/90 px-6 text-center">
            <Spinner />
            <p className="text-sm text-slate-300">Connecting to the agent…</p>
            <p className="text-xs text-slate-500">Accept the screen-share dialog on the computer if it appears.</p>
          </div>
        )}
        {approvalNeeded && (
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 bg-slate-950/95 px-4 py-2.5">
            <span aria-hidden="true" className="size-2 rounded-full bg-amber-400" />
            <p className="text-xs text-amber-200">
              Approve the screen-share dialog on the computer to start the stream.
            </p>
          </div>
        )}
        {starting && (
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 bg-slate-950/95 px-4 py-2.5">
            <span aria-hidden="true" className="size-2 rounded-full bg-indigo-400" />
            <p className="text-xs text-indigo-200">Approval received — waiting for the first frame…</p>
          </div>
        )}
        {showInterrupted && (
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 bg-slate-950/95 px-4 py-2.5">
            <span aria-hidden="true" className="size-2 rounded-full bg-rose-400" />
            <p className="text-xs text-rose-200">Connection interrupted — waiting to recover…</p>
          </div>
        )}
        {control.enabled && status === 'live' && (
          <div className="pointer-events-none absolute right-2 top-2 flex items-center gap-1.5 rounded-full border border-indigo-500/40 bg-slate-950/85 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-indigo-300">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-indigo-400" />
            Controlling
          </div>
        )}
      </div>
      <RemoteKeyboard
        open={mode === 'keyboard'}
        control={control}
        onClose={() => setMode('mouse')}
      />
      <div className="stream-footer flex items-center justify-between gap-3 border-t border-slate-800 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
        <span className="flex items-center gap-2 text-xs font-medium text-slate-400">
          <span aria-hidden="true" className={`size-2 rounded-full ${footerDot}`} />
          <span className="max-sm:hidden">{footerLabel}</span>
        </span>
        <div className="flex items-center gap-2">
          {status === 'live' && control.available && (
            <>
              <button
                type="button"
                onClick={toggleMouse}
                aria-pressed={mode === 'mouse'}
                className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 ${
                  mode === 'mouse' || mode === 'keyboard'
                    ? 'border-indigo-500 bg-indigo-600 text-white'
                    : 'border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700'
                }`}
              >
                <MouseIcon className="size-3.5" />
                <span className="max-xs:hidden">Mouse</span>
              </button>
              <button
                type="button"
                onClick={toggleKeyboard}
                aria-pressed={mode === 'keyboard'}
                className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 ${
                  mode === 'keyboard'
                    ? 'border-indigo-500 bg-indigo-600 text-white'
                    : 'border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700'
                }`}
              >
                <KeyboardIcon className="size-3.5" />
                <span className="max-xs:hidden">Keys</span>
              </button>
            </>
          )}
          {showFsButton && (
            <button
              type="button"
              onClick={toggleFullscreen}
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              aria-pressed={isFullscreen}
              className="rounded-lg border border-slate-700 bg-slate-800 p-2 text-slate-300 transition hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 active:scale-[0.97]"
            >
              {isFullscreen ? <CollapseIcon className="size-4" /> : <ExpandIcon className="size-4" />}
            </button>
          )}
          <button
            type="button"
            onClick={onDisconnect}
            className="rounded-lg border border-rose-800 bg-rose-950/60 px-3 py-1.5 text-xs font-semibold text-rose-200 transition hover:bg-rose-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-400 active:scale-[0.97]"
          >
            Disconnect
          </button>
        </div>
      </div>
    </section>
  )
}
