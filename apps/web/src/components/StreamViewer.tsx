import type { RefObject } from 'react'
import type { StreamStatus } from '../hooks/useAgentStream'

interface StreamViewerProps {
  videoRef: RefObject<HTMLVideoElement | null>
  status: StreamStatus
  agentState: string | null
  onDisconnect: () => void
}

function Spinner() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-7 animate-spin text-indigo-400" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

export default function StreamViewer({ videoRef, status, agentState, onDisconnect }: StreamViewerProps) {
  const showCapturing = status === 'live' && agentState === 'capturing'
  const showInterrupted = status === 'live' && agentState === 'disconnected'
  const showNegotiating = status === 'connecting'

  return (
    <section className="w-full max-w-3xl overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-lg shadow-black/30">
      <div className="relative aspect-video w-full bg-black">
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
        {showCapturing && (
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 bg-slate-950/85 px-4 py-2.5 backdrop-blur">
            <span aria-hidden="true" className="size-2 animate-pulse rounded-full bg-amber-400" />
            <p className="text-xs text-amber-200">
              Approve the screen-share dialog on the computer to start the stream.
            </p>
          </div>
        )}
        {showInterrupted && (
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 bg-slate-950/85 px-4 py-2.5 backdrop-blur">
            <span aria-hidden="true" className="size-2 rounded-full bg-rose-400" />
            <p className="text-xs text-rose-200">Connection interrupted — waiting to recover…</p>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-slate-800 px-4 py-3">
        <span className="flex items-center gap-2 text-xs font-medium text-slate-400">
          <span aria-hidden="true" className="size-2 rounded-full bg-emerald-400" />
          Live view
        </span>
        <button
          type="button"
          onClick={onDisconnect}
          className="rounded-lg border border-rose-800 bg-rose-950/60 px-3 py-1.5 text-xs font-semibold text-rose-200 transition hover:bg-rose-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-400 active:scale-[0.97]"
        >
          Disconnect
        </button>
      </div>
    </section>
  )
}
