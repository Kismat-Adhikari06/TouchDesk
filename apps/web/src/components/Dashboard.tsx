import { useState, type FormEvent } from 'react'
import { useAgentStream, type StreamStatus } from '../hooks/useAgentStream'
import StreamViewer from './StreamViewer'

const APP_NAME = 'Connect To Desktop'

const STATUS_META: Record<
  StreamStatus,
  { label: string; dot: string; text: string; border: string }
> = {
  idle: {
    label: 'Disconnected',
    dot: 'bg-slate-500',
    text: 'text-slate-300',
    border: 'border-slate-700 bg-slate-800',
  },
  connecting: {
    label: 'Connecting',
    dot: 'bg-indigo-400 animate-pulse',
    text: 'text-indigo-200',
    border: 'border-indigo-800 bg-indigo-950',
  },
  live: {
    label: 'Streaming',
    dot: 'bg-emerald-400',
    text: 'text-emerald-200',
    border: 'border-emerald-800 bg-emerald-950',
  },
  stopped: {
    label: 'Disconnected',
    dot: 'bg-slate-500',
    text: 'text-slate-300',
    border: 'border-slate-700 bg-slate-800',
  },
  error: {
    label: 'Error',
    dot: 'bg-rose-500',
    text: 'text-rose-200',
    border: 'border-rose-800 bg-rose-950',
  },
}

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
  const [address, setAddress] = useState(`${window.location.hostname}:8080`)
  const [pin, setPin] = useState('')
  const [validation, setValidation] = useState<string | null>(null)
  const stream = useAgentStream()

  const statusMeta = STATUS_META[stream.status]
  const streaming = stream.status === 'connecting' || stream.status === 'live'

  function handleConnect(event: FormEvent) {
    event.preventDefault()
    if (!address.trim()) {
      setValidation('Enter the address shown on your computer.')
      return
    }
    if (!pin.trim()) {
      setValidation('Enter the PIN shown on your computer.')
      return
    }
    setValidation(null)
    stream.connect(address, pin)
  }

  return (
    <div className="flex min-h-dvh flex-col bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
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
            aria-label={`Connection status: ${statusMeta.label.toLowerCase()}`}
            className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${statusMeta.border} ${statusMeta.text}`}
          >
            <span aria-hidden="true" className={`size-2 rounded-full ${statusMeta.dot}`} />
            {statusMeta.label}
          </span>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-4 py-8 sm:px-6">
        {streaming ? (
          <StreamViewer
            videoRef={stream.videoRef}
            status={stream.status}
            agentState={stream.agentState}
            onDisconnect={stream.disconnect}
          />
        ) : (
          <section className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900 p-6 text-center shadow-lg shadow-black/30 sm:p-8">
            <MonitorGlyph className="mx-auto size-14 text-slate-600" />
            <h2 className="mt-4 text-lg font-semibold text-slate-100">Connect to your computer</h2>
            <p className="mt-1 text-sm text-slate-400">
              Enter the address and PIN printed in the desktop agent's terminal.
            </p>

            <form onSubmit={handleConnect} className="mt-6 space-y-3 text-left">
              <div>
                <label htmlFor="agent-address" className="block text-xs font-medium text-slate-400">
                  Agent address
                </label>
                <input
                  id="agent-address"
                  type="text"
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  placeholder="192.168.1.24:8080"
                  spellCheck={false}
                  autoComplete="off"
                  inputMode="url"
                  className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400"
                />
              </div>
              <div>
                <label htmlFor="agent-pin" className="block text-xs font-medium text-slate-400">
                  PIN
                </label>
                <input
                  id="agent-pin"
                  type="password"
                  value={pin}
                  onChange={(event) => setPin(event.target.value)}
                  placeholder="6 digits"
                  autoComplete="off"
                  inputMode="numeric"
                  maxLength={6}
                  className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm tracking-widest text-slate-100 placeholder:tracking-normal placeholder:text-slate-600 focus:border-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400"
                />
              </div>
              <button
                type="submit"
                className="w-full rounded-xl bg-indigo-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-indigo-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 active:scale-[0.98]"
              >
                Connect Device
              </button>
            </form>

            {validation && (
              <p
                role="status"
                className="mt-4 rounded-lg border border-amber-900 bg-amber-950/60 px-3 py-2 text-xs leading-relaxed text-amber-300"
              >
                {validation}
              </p>
            )}
            {stream.status === 'error' && stream.error && (
              <p
                role="alert"
                className="mt-4 rounded-lg border border-rose-900 bg-rose-950/60 px-3 py-2 text-xs leading-relaxed text-rose-300"
              >
                {stream.error}
              </p>
            )}
            {stream.status === 'stopped' && (
              <p
                role="status"
                className="mt-4 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-xs leading-relaxed text-slate-300"
              >
                Session ended.
              </p>
            )}
          </section>
        )}
      </main>

      <footer className="px-4 py-4 text-center text-xs text-slate-500 sm:px-6">
        Open-source remote desktop · Phase 2
      </footer>
    </div>
  )
}
