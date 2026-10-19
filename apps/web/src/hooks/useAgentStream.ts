import { useCallback, useEffect, useRef, useState } from 'react'

export type StreamStatus = 'idle' | 'connecting' | 'live' | 'stopped' | 'error'

export type ControlButton = 'left' | 'right' | 'middle'

export interface RemoteControl {
  /** The computer reported that it can simulate input. */
  available: boolean
  /** Remote control is currently authorized for this session. */
  enabled: boolean
  /** Remote screen size in pixels (0x0 when unknown). */
  remoteWidth: number
  remoteHeight: number
  setEnabled: (on: boolean) => void
  sendMove: (dx: number, dy: number) => void
  sendScroll: (dx: number, dy: number) => void
  sendButton: (button: ControlButton, state: 'down' | 'up') => void
  sendClick: (button: ControlButton, double?: boolean) => void
  sendText: (text: string) => void
  sendKey: (key: string, state: 'down' | 'up') => void
}

interface AgentMessage {
  type?: string
  message?: string
  sdp?: string
  state?: string
  candidate?: unknown
}

function toWsUrl(address: string): string {
  let target = address.trim()
  target = target.replace(/^wss?:\/\//i, '')
  target = target.replace(/^https?:\/\//i, '')
  target = target.replace(/\/+$/, '')
  target = target.replace(/\/ws$/, '')
  if (!/:\d+$/.test(target)) target = `${target}:8080`
  return `ws://${target}/ws`
}

export function useAgentStream() {
  const [status, setStatus] = useState<StreamStatus>('idle')
  const [agentState, setAgentState] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [controlAvailable, setControlAvailable] = useState(false)
  const [controlEnabled, setControlEnabled] = useState(false)
  const [remoteSize, setRemoteSize] = useState({ width: 0, height: 0 })
  const videoRef = useRef<HTMLVideoElement | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const statusRef = useRef<StreamStatus>('idle')
  const intentionalCloseRef = useRef(false)
  const chainRef = useRef<Promise<void>>(Promise.resolve())

  const controlChannelRef = useRef<RTCDataChannel | null>(null)
  const controlEnabledRef = useRef(false)
  const moveBufferRef = useRef({ dx: 0, dy: 0 })
  const scrollBufferRef = useRef({ dx: 0, dy: 0 })
  const moveScheduledRef = useRef(false)
  const scrollScheduledRef = useRef(false)

  const setPhase = useCallback((next: StreamStatus) => {
    statusRef.current = next
    setStatus(next)
  }, [])

  const sendControl = useCallback((payload: Record<string, unknown>) => {
    const dc = controlChannelRef.current
    if (!dc || dc.readyState !== 'open') return
    try {
      dc.send(JSON.stringify(payload))
    } catch {
      // The channel died between the readyState check and the send.
    }
  }, [])

  const setEnabled = useCallback(
    (on: boolean) => {
      controlEnabledRef.current = on
      if (!on) {
        moveBufferRef.current = { dx: 0, dy: 0 }
        scrollBufferRef.current = { dx: 0, dy: 0 }
      }
      sendControl({ type: 'control', enabled: on })
      setControlEnabled(on)
    },
    [sendControl],
  )

  // Moves and scrolls are coalesced to one message per animation frame.
  const sendMove = useCallback(
    (dx: number, dy: number) => {
      if (!controlEnabledRef.current) return
      moveBufferRef.current.dx += dx
      moveBufferRef.current.dy += dy
      if (moveScheduledRef.current) return
      moveScheduledRef.current = true
      requestAnimationFrame(() => {
        moveScheduledRef.current = false
        const { dx: bufferedX, dy: bufferedY } = moveBufferRef.current
        moveBufferRef.current = { dx: 0, dy: 0 }
        if (bufferedX === 0 && bufferedY === 0) return
        sendControl({
          type: 'move',
          dx: Math.round(bufferedX),
          dy: Math.round(bufferedY),
        })
      })
    },
    [sendControl],
  )

  const sendScroll = useCallback(
    (dx: number, dy: number) => {
      if (!controlEnabledRef.current) return
      scrollBufferRef.current.dx += dx
      scrollBufferRef.current.dy += dy
      if (scrollScheduledRef.current) return
      scrollScheduledRef.current = true
      requestAnimationFrame(() => {
        scrollScheduledRef.current = false
        const { dx: bufferedX, dy: bufferedY } = scrollBufferRef.current
        scrollBufferRef.current = { dx: 0, dy: 0 }
        if (bufferedX === 0 && bufferedY === 0) return
        sendControl({
          type: 'scroll',
          dx: Math.round(bufferedX),
          dy: Math.round(bufferedY),
        })
      })
    },
    [sendControl],
  )

  const sendButton = useCallback(
    (button: ControlButton, state: 'down' | 'up') => {
      if (!controlEnabledRef.current) return
      sendControl({ type: 'button', button, state })
    },
    [sendControl],
  )

  const sendClick = useCallback(
    (button: ControlButton, double?: boolean) => {
      if (!controlEnabledRef.current) return
      sendControl({ type: 'click', button, double: double ?? false })
    },
    [sendControl],
  )

  const sendText = useCallback(
    (text: string) => {
      if (!controlEnabledRef.current || !text) return
      sendControl({ type: 'text', text })
    },
    [sendControl],
  )

  const sendKey = useCallback(
    (key: string, state: 'down' | 'up') => {
      if (!controlEnabledRef.current) return
      sendControl({ type: 'key', key, state })
    },
    [sendControl],
  )

  const teardown = useCallback(() => {
    intentionalCloseRef.current = true
    const ws = wsRef.current
    wsRef.current = null
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close()
    }
    const dc = controlChannelRef.current
    controlChannelRef.current = null
    controlEnabledRef.current = false
    try {
      dc?.close()
    } catch {
      // Already gone.
    }
    setControlEnabled(false)
    setControlAvailable(false)
    setRemoteSize({ width: 0, height: 0 })
    const pc = pcRef.current
    pcRef.current = null
    pc?.close()
    if (videoRef.current) videoRef.current.srcObject = null
  }, [])

  const fail = useCallback(
    (message: string) => {
      teardown()
      setAgentState(null)
      setError(message)
      setPhase('error')
    },
    [setPhase, teardown],
  )

  const disconnect = useCallback(() => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stop' }))
    }
    teardown()
    setAgentState(null)
    setError(null)
    setPhase('stopped')
  }, [setPhase, teardown])

  const connect = useCallback(
    (address: string, pin: string) => {
      teardown()
      chainRef.current = Promise.resolve()
      intentionalCloseRef.current = false
      setAgentState(null)
      setError(null)
      setPhase('connecting')

      let ws: WebSocket
      try {
        ws = new WebSocket(toWsUrl(address))
      } catch {
        setError('That address does not look right.')
        setPhase('error')
        return
      }
      wsRef.current = ws

      const send = (payload: Record<string, unknown>) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
      }

      const handleMessage = async (msg: AgentMessage) => {
        if (wsRef.current !== ws) return
        switch (msg.type) {
          case 'auth_ok': {
            send({ type: 'start' })
            break
          }
          case 'auth_error': {
            fail(msg.message ?? 'Authentication failed.')
            break
          }
          case 'error': {
            fail(msg.message ?? 'The agent reported an error.')
            break
          }
          case 'offer': {
            if (!msg.sdp) break
            const pc = new RTCPeerConnection()
            pcRef.current = pc
            pc.ontrack = (event) => {
              const stream = new MediaStream([event.track])
              if (videoRef.current) videoRef.current.srcObject = stream
              if (statusRef.current === 'connecting') setPhase('live')
            }
            pc.onicecandidate = (event) => {
              if (event.candidate) send({ type: 'ice', candidate: event.candidate.toJSON() })
            }
            pc.ondatachannel = (event) => {
              const dc = event.channel
              if (dc.label !== 'control') {
                try {
                  dc.close()
                } catch {
                  // Ignore channels we do not use.
                }
                return
              }
              controlChannelRef.current = dc
              dc.onopen = () => {
                // Re-assert the last authorization state if the channel reopens.
                if (controlEnabledRef.current) {
                  const dc2 = controlChannelRef.current
                  if (dc2 && dc2.readyState === 'open') {
                    try {
                      dc2.send(JSON.stringify({ type: 'control', enabled: true }))
                    } catch {
                      // ignore
                    }
                  }
                }
              }
              dc.onclose = () => {
                if (controlChannelRef.current === dc) {
                  controlChannelRef.current = null
                }
                controlEnabledRef.current = false
                setControlEnabled(false)
              }
              dc.onmessage = (dcEvent) => {
                if (typeof dcEvent.data !== 'string') return
                try {
                  const msg = JSON.parse(dcEvent.data) as {
                    type?: string
                    width?: number
                    height?: number
                    control?: boolean
                  }
                  if (msg.type === 'info') {
                    setControlAvailable(Boolean(msg.control))
                    setRemoteSize({
                      width: typeof msg.width === 'number' ? msg.width : 0,
                      height: typeof msg.height === 'number' ? msg.height : 0,
                    })
                  }
                } catch {
                  // Ignore malformed messages from the agent.
                }
              }
            }
            await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp })
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            send({ type: 'answer', sdp: answer.sdp })
            break
          }
          case 'ice': {
            if (msg.candidate && pcRef.current) {
              try {
                await pcRef.current.addIceCandidate(msg.candidate as RTCIceCandidateInit)
              } catch {
                // Late or duplicate candidates can be rejected safely.
              }
            }
            break
          }
          case 'state': {
            setAgentState(msg.state ?? null)
            if (msg.state === 'connected' && statusRef.current === 'connecting') {
              setPhase('live')
            }
            if (msg.state === 'failed') {
              fail('The connection failed. Check that both devices are on the same network.')
            }
            break
          }
          case 'stopped': {
            const intentional = intentionalCloseRef.current
            teardown()
            setAgentState(null)
            if (!intentional) setPhase('stopped')
            break
          }
          default: {
            break
          }
        }
      }

      ws.onmessage = (event) => {
        if (typeof event.data !== 'string') return
        const raw = event.data
        chainRef.current = chainRef.current
          .then(() => {
            let msg: AgentMessage
            try {
              msg = JSON.parse(raw) as AgentMessage
            } catch {
              return
            }
            return handleMessage(msg)
          })
          .catch((err: unknown) => {
            fail(err instanceof Error ? `Stream error: ${err.message}` : 'Stream error.')
          })
      }

      ws.onclose = () => {
        if (intentionalCloseRef.current) return
        const pc = pcRef.current
        pcRef.current = null
        pc?.close()
        if (videoRef.current) videoRef.current.srcObject = null
        if (statusRef.current === 'connecting') {
          setError('Lost connection to the agent. Check the address and that both devices are on the same network.')
          setPhase('error')
        } else if (statusRef.current === 'live') {
          setPhase('stopped')
        }
      }

      ws.onerror = () => {
        if (intentionalCloseRef.current) return
        if (statusRef.current === 'connecting') {
          setError('Could not reach the agent at that address.')
          setPhase('error')
          teardown()
        }
      }

      ws.onopen = () => {
        send({ type: 'auth', pin })
      }
    },
    [fail, setPhase, teardown],
  )

  useEffect(() => teardown, [teardown])

  const control: RemoteControl = {
    available: controlAvailable,
    enabled: controlEnabled,
    remoteWidth: remoteSize.width,
    remoteHeight: remoteSize.height,
    setEnabled,
    sendMove,
    sendScroll,
    sendButton,
    sendClick,
    sendText,
    sendKey,
  }

  return { status, agentState, error, videoRef, control, connect, disconnect }
}
