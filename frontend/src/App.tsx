import { useEffect, useRef, useState } from 'react'
import './App.css'

type ConnectionStatus =
  | 'idle'
  | 'requesting-camera'
  | 'negotiating'
  | 'streaming'
  | 'stopping'
  | 'error'

type OfferResponse = {
  session_id: string
  answer: {
    sdp: string
    type: RTCSdpType
  }
}

// ICE の収集が終わるまで待つ。
// WebRTC は「映像の中身」だけでなく、「相手とどうやってつながるか」の情報も
// SDP に含める。そのため、backend に送る前に candidate の収集完了を待つ。
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

function App() {
  // video 要素そのものを直接触るための参照。
  // React の state ではなく DOM を直接使うのは、video の表示先を差し替えるだけだから。
  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null)
  // WebRTC の接続本体。
  // ブラウザ側の送受信設定、SDP の作成、イベント受信をまとめて持つ。
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null)
  // getUserMedia() で取得したカメラ映像を保持する。
  // Stop 時に track.stop() するため、ここで覚えておく。
  const localStreamRef = useRef<MediaStream | null>(null)
  // backend 側が接続管理のために返す ID。
  // Stop 時にこの ID を渡して backend 側の接続を閉じる。
  const sessionIdRef = useRef<string | null>(null)

  const [status, setStatus] = useState<ConnectionStatus>('idle')
  const [message, setMessage] = useState('カメラ映像を backend に送って表示します。')
  const [error, setError] = useState<string | null>(null)

  // 停止処理をまとめた関数。
  // 画面上の video と WebRTC 接続とカメラを、順番にきれいに片付ける。
  const cleanup = async (updateUi: boolean) => {
    const pc = peerConnectionRef.current
    const sessionId = sessionIdRef.current
    const stream = localStreamRef.current

    // 先に参照を切る。
    // 以降の処理で二重クリーンアップしても安全になりやすい。
    peerConnectionRef.current = null
    sessionIdRef.current = null
    localStreamRef.current = null

    if (pc) {
      // イベントを外してから close() する。
      // こうしておくと、閉じる途中のイベントで画面更新が走りにくい。
      pc.ontrack = null
      pc.onconnectionstatechange = null
      pc.close()
    }

    if (stream) {
      // カメラの利用を止める。
      // track を止めないと、ブラウザ上でカメラランプがつき続けることがある。
      stream.getTracks().forEach((track) => track.stop())
    }

    if (localVideoRef.current) {
      // 画面上の表示も外す。
      localVideoRef.current.srcObject = null
    }

    if (remoteVideoRef.current) {
      // backend からの表示も外す。
      remoteVideoRef.current.srcObject = null
    }

    if (sessionId) {
      try {
        // backend 側にも「この接続はもう使わない」と伝える。
        // 失敗しても UI 側の停止は優先するので、ここは best-effort。
        await fetch('/api/webrtc/close/', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ session_id: sessionId }),
        })
      } catch {
        // Backend cleanup is best-effort.
      }
    }

    if (updateUi) {
      setStatus('idle')
      setMessage('停止しました。')
    }
  }

  const stop = async () => {
    // UI 上は「停止中」にしてから後片付けをする。
    setStatus('stopping')
    await cleanup(true)
  }

  const start = async () => {
    // 以前のエラーは消して、これから始まる処理用の文言に変える。
    setError(null)
    setMessage('カメラを起動しています...')
    setStatus('requesting-camera')

    try {
      // まずブラウザにカメラを要求する。
      // ここで返る stream は「今後カメラから流れてくる映像の入れ物」。
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      })

      // 後で stop できるように保持する。
      localStreamRef.current = stream

      // local の video に stream を突っ込むと、ブラウザが自動で再生してくれる。
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream
      }

      // ブラウザ側の WebRTC 接続を作る。
      // この時点ではまだ backend と未接続。
      const pc = new RTCPeerConnection()
      peerConnectionRef.current = pc

      // backend から映像トラックが届いたら呼ばれる。
      pc.ontrack = (event) => {
        // event.streams[0] に、backend が送ってきた MediaStream が入る。
        const [remoteStream] = event.streams
        if (remoteVideoRef.current) {
          // remote の video に入れると、受信した映像が表示される。
          remoteVideoRef.current.srcObject = remoteStream
        }
      }

      // 接続状態の変化を監視する。
      // connected になったら「通信が成立した」と判断できる。
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          setStatus('streaming')
          setMessage('backend から映像を受信中です。')
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          setStatus('error')
          setError(`接続状態: ${pc.connectionState}`)
          setMessage('接続が切れました。')
        }
      }

      // MediaStream の中にある video track を 1 本ずつ WebRTC に追加する。
      // これで「このカメラ映像を送る」という設定になる。
      stream.getVideoTracks().forEach((track) => pc.addTrack(track, stream))

      setStatus('negotiating')
      setMessage('接続を開始しています...')

      // Offer を作る。
      // Offer は「私はこういう設定で通信したい」という提案書。
      const offer = await pc.createOffer()
      // localDescription に入れることで、ブラウザ側の提案内容を確定させる。
      await pc.setLocalDescription(offer)
      // ICE candidate が集まりきるまで待つ。
      await waitForIceGatheringComplete(pc)

      // backend に Offer を送る。
      // ここで backend は answer を返し、接続の条件がそろう。
      const response = await fetch('/api/webrtc/offer/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          session_id: sessionIdRef.current ?? crypto.randomUUID(),
          offer: {
            sdp: pc.localDescription?.sdp,
            type: pc.localDescription?.type,
          },
        }),
      })

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { detail?: string }
          | null
        throw new Error(payload?.detail ?? `backend error: ${response.status}`)
      }

      // backend から session_id と answer を受け取る。
      const data = (await response.json()) as OfferResponse
      sessionIdRef.current = data.session_id

      // backend の Answer を登録する。
      // これで「相手もこの条件で OK」と合意したことになる。
      await pc.setRemoteDescription(data.answer)
      setStatus('streaming')
      setMessage('接続完了。映像を表示しています。')
    } catch (caughtError) {
      // 途中で失敗したら、画面にエラーを出して接続状態も掃除する。
      const nextError =
        caughtError instanceof Error ? caughtError.message : '不明なエラーが発生しました'
      setError(nextError)
      setStatus('error')
      setMessage('接続に失敗しました。')
      await cleanup(false)
    }
  }

  useEffect(() => {
    // コンポーネントが消えるときは、接続を残さない。
    return () => {
      void cleanup(false)
    }
  }, [])

  return (
    <main className="page">
      <section className="shell">
        <div className="header">
          <h1>WebRTC Demo</h1>
          <p>
            ブラウザのカメラを backend に送り、Pythonでグレースケール化してブラウザへ返して表示します。
          </p>
        </div>

        <div className="actions">
          <button type="button" className="primary" onClick={start} disabled={status !== 'idle'}>
            Start
          </button>
          <button type="button" className="secondary" onClick={() => void stop()} disabled={status === 'idle'}>
            Stop
          </button>
        </div>

        <div className="status-row">
          {/* 今どの工程にいるかを短く表示する。 */}
          <span className={`status status-${status}`}>{status}</span>
          <span className="message">{message}</span>
        </div>

        {error ? <div className="error-box">{error}</div> : null}

        <section className="grid">
          <article className="panel">
            <div className="panel-head">
              <h2>Local</h2>
              <span>camera</span>
            </div>
            {/* 自分のカメラ映像。muted は自分の音を返さないための定番設定。 */}
            <video ref={localVideoRef} autoPlay playsInline muted className="video video-local" />
          </article>

          <article className="panel">
            <div className="panel-head">
              <h2>Remote</h2>
              <span>backend output</span>
            </div>
            {/* backend から返ってきた映像。 */}
            <video ref={remoteVideoRef} autoPlay playsInline className="video video-remote" />
          </article>
        </section>
      </section>
    </main>
  )
}

export default App
