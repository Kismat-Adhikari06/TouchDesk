import { useCallback, useEffect, useRef, useState } from 'react'

export type StreamStatus = 'idle' | 'connecting' | 'live' | 'stopped' | 'error'

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
  const videoRef = useRef<HTMLVideoElement | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const statusRef = useRef<StreamStatus>('idle')
  const intentionalCloseRef = useRef(false)
  const chainRef = useRef<Promise<void>>(Promise.resolve())

  const setPhase = useCallback((next: StreamStatus) => {
    statusRef.current = next
    setStatus(next)
  }, [])

  const teardown = useCallback(() => {
    intentionalCloseRef.current = true
    const ws = wsRef.current
    wsRef.current = null
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close()
    }
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

  return { status, agentState, error, videoRef, connect, disconnect }
}
