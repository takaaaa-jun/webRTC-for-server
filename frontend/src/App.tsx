import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  buildPoseSummary,
  drawPoseFrame,
  normalizeLandmarks,
  type PoseDisplayMode,
  type PoseFrame,
  type PoseSummaryRow,
} from './pose'

type Mode = 'send' | 'view'
type ConnectionStatus = 'idle' | 'requesting-camera' | 'negotiating' | 'streaming' | 'retrying' | 'stopping' | 'error'
type OfferResponse = {
  session_id: string
  room_id: string
  answer: { sdp: string; type: RTCSdpType }
}
type PoseLatestResponse = {
  room_id: string
  pose: PoseFrame
}

const DEFAULT_ROOM_ID = 'default'
const POSE_POLL_INTERVAL_MS = 250
const POSE_POST_INTERVAL_MS = 120

function waitForIceGatheringComplete(pc: RTCPeerConnection) {
  if (pc.iceGatheringState === 'complete') {
    return Promise.resolve()
  }

  return new Promise<void>((resolve) => {
    const checkState = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', checkState)
        resolve()
      }
    }

    pc.addEventListener('icegatheringstatechange', checkState)
  })
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function toBooleanClass(value: boolean) {
  return value ? 'is-on' : 'is-off'
}

function PoseSummaryTable({ title, rows }: { title: string; rows: PoseSummaryRow[] }) {
  return (
    <div className="poseSummary">
      <div className="poseSummaryTitle">{title}</div>
      <div className="poseSummaryList">
        {rows.length ? (
          rows.map((row) => (
            <div key={row.label} className="poseSummaryRow">
              <span className="poseSummaryLabel">{row.label}</span>
              <span className="poseSummaryValue">
                {row.visibility === null ? '—' : `v=${row.visibility.toFixed(2)}`}
              </span>
              <span className="poseSummaryValue">
                x={row.x.toFixed(3)} / y={row.y.toFixed(3)}
              </span>
            </div>
          ))
        ) : (
          <div className="poseSummaryEmpty">骨格データがまだありません。</div>
        )}
      </div>
    </div>
  )
}

function App() {
  const mode: Mode = useMemo(() => (window.location.pathname.includes('/view') ? 'view' : 'send'), [])

  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null)
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const abortRef = useRef(false)
  const poseTimerRef = useRef<number | null>(null)
  const poseBusyRef = useRef(false)
  const lastPosePostAtRef = useRef(0)
  const activePoseInstanceRef = useRef<any>(null)

  const [status, setStatus] = useState<ConnectionStatus>('idle')
  const [message, setMessage] = useState(
    mode === 'send'
      ? 'カメラ PC で送信を開始します。別 PC は /view を開いて確認します。'
      : '視聴用ページです。送信 PC が先に Start してから Connect してください。',
  )
  const [error, setError] = useState<string | null>(null)
  const [roomId, setRoomId] = useState(DEFAULT_ROOM_ID)
  const [displayMode, setDisplayMode] = useState<PoseDisplayMode>('both')
  const [localPoseFrame, setLocalPoseFrame] = useState<PoseFrame | null>(null)
  const [latestPoseFrame, setLatestPoseFrame] = useState<PoseFrame | null>(null)
  const [viewerPollStatus, setViewerPollStatus] = useState<'idle' | 'polling' | 'waiting' | 'ready'>('idle')

  const activePoseFrame = mode === 'send' ? localPoseFrame : latestPoseFrame
  const keySummary = buildPoseSummary(activePoseFrame)
  const backendBase = `http://${window.location.hostname}:8000`

  const clearPoseLoop = () => {
    if (poseTimerRef.current !== null) {
      window.clearTimeout(poseTimerRef.current)
      poseTimerRef.current = null
    }
    try {
      activePoseInstanceRef.current?.close?.()
    } catch {
      // ignore
    }
    poseBusyRef.current = false
    activePoseInstanceRef.current = null
  }

  const drawCurrentFrame = (frame: PoseFrame | null) => {
    const canvas = overlayCanvasRef.current
    if (!canvas) {
      return
    }
    drawPoseFrame(canvas, frame, {
      showLabels: mode === 'send',
      emptyText: mode === 'send' ? 'MediaPipe で骨格を検出中...' : '送信 PC の骨格データを待機中',
    })
  }

  const uploadPoseFrame = async (frame: PoseFrame) => {
    const now = Date.now()
    if (now - lastPosePostAtRef.current < POSE_POST_INTERVAL_MS) {
      return
    }
    lastPosePostAtRef.current = now

    try {
      await fetch('/api/webrtc/pose/update/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(frame),
      })
    } catch {
      // best effort: viewer can still use the live WebRTC stream
    }
  }

  const stopAll = async (updateUi: boolean) => {
    abortRef.current = true
    clearPoseLoop()

    const pc = peerConnectionRef.current
    const sessionId = sessionIdRef.current
    const stream = localStreamRef.current

    peerConnectionRef.current = null
    sessionIdRef.current = null
    localStreamRef.current = null

    if (pc) {
      pc.ontrack = null
      pc.onconnectionstatechange = null
      pc.close()
    }

    if (stream) {
      stream.getTracks().forEach((track) => track.stop())
    }

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null
    }

    drawCurrentFrame(null)

    if (sessionId) {
      try {
        await fetch('/api/webrtc/close/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId }),
        })
      } catch {
        // best effort
      }
    }

    if (updateUi) {
      setStatus('idle')
      setMessage(mode === 'send' ? '停止しました。' : '切断しました。')
      setViewerPollStatus('idle')
    }
  }

  const startPoseAnalysis = async (video: HTMLVideoElement, room: string) => {
    const { FilesetResolver, PoseLandmarker } = await import('@mediapipe/tasks-vision')

    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm',
    )

    const pose = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-tasks/pose_landmarker/pose_landmarker_lite.task',
      },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.55,
      minPosePresenceConfidence: 0.55,
      minTrackingConfidence: 0.55,
    })

    activePoseInstanceRef.current = pose

    const tick = async () => {
      if (abortRef.current) {
        return
      }

      const ready = video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      if (!ready) {
        poseTimerRef.current = window.setTimeout(tick, 120)
        return
      }

      if (!poseBusyRef.current) {
        poseBusyRef.current = true
        try {
          const timestamp = performance.now()
          const result = pose.detectForVideo(video, timestamp)

          const landmarks = normalizeLandmarks(
            (result.landmarks?.[0] ?? []) as Array<Record<string, unknown>>,
          )

          const frame: PoseFrame = {
            room_id: room,
            updated_at: Date.now(),
            image_width: video.videoWidth || 1280,
            image_height: video.videoHeight || 720,
            landmarks,
          }

          setLocalPoseFrame(frame)
          drawCurrentFrame(frame)
          void uploadPoseFrame(frame)
        } catch (err) {
          if (!abortRef.current) {
            console.error('Pose inference failed:', err)
          }
        } finally {
          poseBusyRef.current = false
        }
      }

      poseTimerRef.current = window.setTimeout(tick, 90)
    }

    tick()
  }

  useEffect(() => {
    return () => {
      abortRef.current = true
      void stopAll(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (mode !== 'view') {
      return
    }

    let cancelled = false
    let timerId: number | null = null

    const poll = async () => {
      if (cancelled) {
        return
      }

      setViewerPollStatus((current) => (current === 'ready' ? 'ready' : 'polling'))

      try {
        const response = await fetch(`/api/webrtc/pose/latest/?room_id=${encodeURIComponent(roomId)}`)
        if (response.ok) {
          const data = (await response.json()) as PoseLatestResponse
          setLatestPoseFrame(data.pose)
          setViewerPollStatus('ready')
          if (data.pose?.landmarks?.length) {
            drawCurrentFrame(data.pose)
          }
        } else if (response.status === 404) {
          setLatestPoseFrame(null)
          setViewerPollStatus('waiting')
          drawCurrentFrame(null)
        }
      } catch {
        if (!cancelled) {
          setViewerPollStatus('waiting')
        }
      }

      timerId = window.setTimeout(poll, POSE_POLL_INTERVAL_MS)
    }

    void poll()

    return () => {
      cancelled = true
      if (timerId !== null) {
        window.clearTimeout(timerId)
      }
    }
  }, [mode, roomId])

  useEffect(() => {
    if (mode === 'send') {
      drawCurrentFrame(localPoseFrame)
      return
    }

    if (displayMode === 'video') {
      drawCurrentFrame(null)
      return
    }

    drawCurrentFrame(latestPoseFrame)
  }, [displayMode, latestPoseFrame, localPoseFrame, mode])

  const startSend = async () => {
    abortRef.current = false
    setError(null)
    setStatus('requesting-camera')
    setMessage('カメラを取得しています。')
    setLocalPoseFrame(null)
    setLatestPoseFrame(null)

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      if (abortRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }

      localStreamRef.current = stream
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream
      }

      const pc = new RTCPeerConnection()
      peerConnectionRef.current = pc
      const [track] = stream.getVideoTracks()
      pc.addTrack(track, stream)

      setStatus('negotiating')
      setMessage('backend と接続しています。')

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      await waitForIceGatheringComplete(pc)

      const response = await fetch('/api/webrtc/offer/send/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          room_id: roomId,
          offer: pc.localDescription,
        }),
      })

      if (!response.ok) {
        throw new Error(await response.text())
      }

      const data = (await response.json()) as OfferResponse
      sessionIdRef.current = data.session_id
      await pc.setRemoteDescription(data.answer)

      if (localVideoRef.current) {
        await startPoseAnalysis(localVideoRef.current, roomId)
      }

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          setStatus('streaming')
          setMessage('送信中です。別 PC の /view で確認できます。')
        } else if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
          setStatus('error')
          setMessage(`接続状態: ${pc.connectionState}`)
        }
      }
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err)
      setError(messageText)
      setStatus('error')
      setMessage('送信に失敗しました。')
      await stopAll(false)
    }
  }

  const startView = async () => {
    abortRef.current = false
    setError(null)
    setStatus('retrying')
    setMessage('送信 PC の映像を待っています。')

    let attempt = 0
    while (!abortRef.current) {
      attempt += 1
      const pc = new RTCPeerConnection()
      peerConnectionRef.current = pc
      pc.addTransceiver('video', { direction: 'recvonly' })

      pc.ontrack = (event) => {
        const [stream] = event.streams
        if (remoteVideoRef.current && stream) {
          remoteVideoRef.current.srcObject = stream
        }
      }

      try {
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        await waitForIceGatheringComplete(pc)

        const response = await fetch('/api/webrtc/offer/view/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            room_id: roomId,
            offer: pc.localDescription,
          }),
        })

        if (response.status === 409) {
          await pc.close()
          peerConnectionRef.current = null
          setStatus('retrying')
          setMessage(`送信待ちです... (${attempt})`)
          setViewerPollStatus('waiting')
          await sleep(1500)
          continue
        }

        if (!response.ok) {
          throw new Error(await response.text())
        }

        const data = (await response.json()) as OfferResponse
        sessionIdRef.current = data.session_id
        await pc.setRemoteDescription(data.answer)

        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'connected') {
            setStatus('streaming')
            setMessage('視聴中です。')
            setViewerPollStatus('ready')
          } else if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
            setStatus('error')
            setMessage(`接続状態: ${pc.connectionState}`)
          }
        }

        break
      } catch (err) {
        const messageText = err instanceof Error ? err.message : String(err)
        setError(messageText)
        setStatus('error')
        setMessage('視聴に失敗しました。')
        await stopAll(false)
        await sleep(1500)
      }
    }
  }

  const onStart = async () => {
    if (mode === 'send') {
      await startSend()
      return
    }
    await startView()
  }

  const onStop = async () => {
    setStatus('stopping')
    setMessage('停止しています。')
    await stopAll(true)
  }

  const pageTitle = mode === 'send' ? '送信用 PC' : '視聴用 PC'
  const leadText =
    mode === 'send'
      ? 'この画面でカメラ映像を backend に送ります。MediaPipe で骨格を検出し、別 PC では /view を開いて同じ room_id の映像と骨格データを受信できます。'
      : 'この画面は視聴専用です。送信 PC が先に起動していれば、映像と骨格データを受け取れます。'

  const streamStatusClass =
    status === 'streaming' ? 'ok' : status === 'error' ? 'err' : status === 'retrying' ? 'warn' : ''

  const displayModeLabel =
    displayMode === 'video' ? '映像だけ' : displayMode === 'skeleton' ? '骨格だけ' : '同時表示'

  return (
    <div className="page">
      <div className="shell">
        <section className="hero">
          <div className="badges">
            <span className="badge">WebRTC LAN test</span>
            <span className="badge">room: {roomId}</span>
            <span className="badge">mode: {pageTitle}</span>
            <span className="badge">pose: {displayModeLabel}</span>
          </div>
          <h1>{pageTitle}</h1>
          <p>{leadText}</p>
          <div className="field" style={{ maxWidth: 380 }}>
            <label htmlFor="room-id">room_id</label>
            <input
              id="room-id"
              value={roomId}
              onChange={(event) => setRoomId(event.target.value.trim() || DEFAULT_ROOM_ID)}
              placeholder="default"
            />
          </div>
          <div className="controls">
            <button
              className="primary"
              onClick={() => void onStart()}
              disabled={status === 'requesting-camera' || status === 'negotiating'}
            >
              Start
            </button>
            <button className="secondary" onClick={() => void onStop()} disabled={status === 'idle'}>
              Stop
            </button>
            <a className="secondary" href={mode === 'send' ? '/view' : '/send'}>
              Switch to {mode === 'send' ? 'view' : 'send'}
            </a>
          </div>
          <div className={`status ${streamStatusClass}`}>{message}</div>
          {error ? <div className="status err">{error}</div> : null}
        </section>

        <section className="layout">
          <div className="card">
            <div className="cardHeadingRow">
              <h2>{mode === 'send' ? 'Local preview + MediaPipe' : 'Remote stream + Skeleton overlay'}</h2>
              {mode === 'view' ? (
                <div className="modeSwitches" aria-label="表示モード切り替え">
                  {(['video', 'skeleton', 'both'] as PoseDisplayMode[]).map((option) => (
                    <button
                      key={option}
                      className={`miniButton ${toBooleanClass(displayMode === option)}`}
                      onClick={() => setDisplayMode(option)}
                      type="button"
                    >
                      {option === 'video' ? '映像だけ' : option === 'skeleton' ? '骨格だけ' : '同時表示'}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div
              className={`stage ${mode === 'view' && displayMode === 'video' ? 'videoOnly' : ''} ${
                mode === 'view' && displayMode === 'skeleton' ? 'skeletonOnly' : ''
              }`}
            >
              <video
                ref={mode === 'send' ? localVideoRef : remoteVideoRef}
                autoPlay
                playsInline
                muted={mode === 'send'}
                className={mode === 'view' && displayMode === 'skeleton' ? 'is-hidden' : ''}
              />
              <canvas
                ref={overlayCanvasRef}
                className={mode === 'view' && displayMode === 'video' ? 'is-hidden' : ''}
              />
            </div>
            <p className="note">
              {mode === 'send'
                ? '送信 PC のカメラ映像に MediaPipe の骨格を重ねて送信します。骨格データも backend に送っているので、別 PC では映像と骨格の両方を確認できます。'
                : '視聴 PC では映像だけ・骨格だけ・同時表示を切り替えられます。骨格データは backend からポーリングして反映します。'}
            </p>
          </div>

          <div className="card">
            <h2>{mode === 'send' ? '検出データ' : '表示と接続メモ'}</h2>
            {mode === 'send' ? (
              <>
                <div className="poseStats">
                  <div className="poseStat">
                    <span className="poseStatLabel">検出フレーム</span>
                    <span className="poseStatValue">{localPoseFrame ? new Date(localPoseFrame.updated_at).toLocaleTimeString() : '—'}</span>
                  </div>
                  <div className="poseStat">
                    <span className="poseStatLabel">ランドマーク数</span>
                    <span className="poseStatValue">{localPoseFrame?.landmarks?.length ?? 0}</span>
                  </div>
                  <div className="poseStat">
                    <span className="poseStatLabel">送信先 room_id</span>
                    <span className="poseStatValue">{roomId}</span>
                  </div>
                </div>
                <PoseSummaryTable title="主要関節の概要" rows={keySummary} />
                <div className="code">
                  <div>backend: {backendBase}</div>
                  <div>frontend: http://{window.location.hostname}:5173</div>
                </div>
              </>
            ) : (
              <>
                <p className="note">
                  1. 送信 PC で /send を開く
                  <br />
                  2. Start を押す
                  <br />
                  3. 別 PC で /view を開く
                  <br />
                  4. 同じ room_id の映像と骨格を見る
                </p>
                <div className="poseStats">
                  <div className="poseStat">
                    <span className="poseStatLabel">接続状態</span>
                    <span className="poseStatValue">{status}</span>
                  </div>
                  <div className="poseStat">
                    <span className="poseStatLabel">骨格ポーリング</span>
                    <span className="poseStatValue">{viewerPollStatus}</span>
                  </div>
                  <div className="poseStat">
                    <span className="poseStatLabel">表示モード</span>
                    <span className="poseStatValue">{displayModeLabel}</span>
                  </div>
                </div>
                <PoseSummaryTable title="最新の骨格データ" rows={keySummary} />
                <div className="code">
                  <div>backend: {backendBase}</div>
                  <div>frontend: http://{window.location.hostname}:5173</div>
                </div>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

export default App
