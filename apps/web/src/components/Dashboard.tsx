import { useState } from 'react'

const APP_NAME = 'Connect To Desktop'

function MonitorGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 64 64"
      className={className}
      fill="none"
    >
      <rect
        x="6"
        y="10"
        width="52"
        height="34"
        rx="5"
        stroke="currentColor"
        strokeWidth="3"
      />
      <rect x="12" y="16" width="40" height="22" rx="2" fill="currentColor" opacity="0.3" />
      <path
        d="M26 50h12M32 44v6"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path d="M22 50h20" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

export default function Dashboard() {
  const [noticeVisible, setNoticeVisible] = useState(false)

  return (
    <div className="flex min-h-dvh flex-col bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <img
              src="/icons/icon-192.png"
              alt=""
              width={32}
              height={32}
              className="size-8 rounded-lg"
            />
            <h1 className="text-sm font-semibold tracking-tight sm:text-base">{APP_NAME}</h1>
          </div>
          <span
            aria-label="Connection status: disconnected"
            className="flex items-center gap-2 rounded-full border border-slate-700 bg-slate-800 px-3 py-1 text-xs font-medium text-slate-300"
          >
            <span aria-hidden="true" className="size-2 rounded-full bg-slate-500" />
            Disconnected
          </span>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center px-4 py-8 sm:px-6">
        <section className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900 p-6 text-center shadow-lg shadow-black/30 sm:p-8">
          <MonitorGlyph className="mx-auto size-14 text-slate-600" />
          <h2 className="mt-4 text-lg font-semibold text-slate-100">No devices connected</h2>
          <p className="mt-1 text-sm text-slate-400">
            Your computers will appear here once the desktop agent is paired.
          </p>
          <button
            type="button"
            onClick={() => setNoticeVisible(true)}
            className="mt-6 w-full rounded-xl bg-indigo-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-indigo-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 active:scale-[0.98]"
          >
            Connect Device
          </button>
          {noticeVisible && (
            <p
              role="status"
              className="mt-4 rounded-lg border border-amber-900 bg-amber-950/60 px-3 py-2 text-xs leading-relaxed text-amber-300"
            >
              Device connections arrive in a later phase.
            </p>
          )}
        </section>
      </main>

      <footer className="px-4 py-4 text-center text-xs text-slate-500 sm:px-6">
        Open-source remote desktop · Phase 1
      </footer>
    </div>
  )
}
