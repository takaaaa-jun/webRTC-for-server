import asyncio
import threading
from typing import Dict

import cv2
import numpy as np
from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.mediastreams import VideoStreamTrack
from av import VideoFrame


def _start_loop() -> asyncio.AbstractEventLoop:
    # Django の通常リクエスト処理とは別に、aiortc 用の asyncio ループを 1 つ常駐させる。
    # こうしておくと、Django の同期 view からでも WebRTC の非同期処理を安全に動かせる。
    loop = asyncio.new_event_loop()

    def run() -> None:
        asyncio.set_event_loop(loop)
        loop.run_forever()

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return loop


AIORTC_LOOP = _start_loop()


class GrayscaleVideoTrack(VideoStreamTrack):
    def __init__(self, source_track: VideoStreamTrack):
        super().__init__()
        # 元の映像トラックを覚えておく。
        # recv() でフレームを取り出して、加工して、返す。
        self._source_track = source_track

    async def recv(self):
        # 1 フレーム分の映像を source_track から受け取る。
        frame = await self._source_track.recv()

        # フレームを RGB の numpy 配列に変換する。
        rgb_image = frame.to_ndarray(format="rgb24")

        # RGB → 1チャンネルの明るさに変換してグレースケールを作る。
        gray = np.dot(rgb_image[..., :3], [0.299, 0.587, 0.114]).astype(np.uint8)

        # 1チャンネルのままだと video として扱いにくいので、3チャンネルに戻す。
        grayscale = np.stack((gray, gray, gray), axis=-1)

        # aiortc が扱える VideoFrame に戻す。
        transformed = VideoFrame.from_ndarray(
            cv2.cvtColor(grayscale, cv2.COLOR_RGB2BGR),
            format="bgr24",
        )
        # 元フレームのタイミング情報を引き継ぐ。
        # これがないと再生がカクついたり順番が崩れやすい。
        transformed.pts = frame.pts
        transformed.time_base = frame.time_base
        return transformed


async def wait_for_ice_gathering_complete(pc: RTCPeerConnection) -> None:
    # browser 側と同じく、candidate の収集が終わるまで待つ。
    while pc.iceGatheringState != "complete":
        await asyncio.sleep(0.05)


class PeerManager:
    def __init__(self) -> None:
        # このファイルで作った専用 event loop を使う。
        self._loop = AIORTC_LOOP
        # session_id ごとに RTCPeerConnection を保持する。
        self._pcs: Dict[str, RTCPeerConnection] = {}
        # 複数スレッドから同時に触っても壊れにくくするための lock。
        self._lock = threading.Lock()

    async def _close_async(self, session_id: str) -> None:
        # 先に辞書から取り出してから close する。
        # こうすると二重 close になりにくい。
        with self._lock:
            pc = self._pcs.pop(session_id, None)

        if pc is not None:
            # 接続と内部のリソースを解放する。
            await pc.close()

    def close(self, session_id: str) -> None:
        if not session_id:
            return

        # Django 側から見れば同期関数でも、中では aiortc の event loop 上で閉じる。
        future = asyncio.run_coroutine_threadsafe(
            self._close_async(session_id),
            self._loop,
        )
        future.result()

    async def _create_answer_async(self, session_id: str, offer: dict) -> dict:
        # 同じ session_id が残っていたら先に消す。
        await self._close_async(session_id)

        # backend 側の WebRTC 接続本体を作る。
        pc = RTCPeerConnection()
        with self._lock:
            self._pcs[session_id] = pc

        # 接続状態が変わったら監視する。
        # failed / closed / disconnected なら後片付けを始める。
        @pc.on("connectionstatechange")
        async def on_connectionstatechange() -> None:
            if pc.connectionState in {"failed", "closed", "disconnected"}:
                asyncio.create_task(self._close_async(session_id))

        # browser から送られてきた track を受け取る。
        # video track が来たら、そのままグレースケール版 track を作って返す。
        @pc.on("track")
        def on_track(track) -> None:
            if track.kind == "video":
                pc.addTrack(GrayscaleVideoTrack(track))

        # browser から届いた Offer を backend の RemoteDescription として登録する。
        await pc.setRemoteDescription(
            RTCSessionDescription(sdp=offer["sdp"], type=offer["type"])
        )

        # Offer を見て Answer を作る。
        answer = await pc.createAnswer()
        # 自分側の Answer を LocalDescription として確定させる。
        await pc.setLocalDescription(answer)
        # ICE candidate の収集が終わるまで待つ。
        await wait_for_ice_gathering_complete(pc)

        # browser に返す answer 用の JSON を作る。
        return {
            "sdp": pc.localDescription.sdp,
            "type": pc.localDescription.type,
        }

    def create_answer(self, session_id: str, offer: dict) -> dict:
        # Django の request handler から呼べるよう、同期関数の形に包んでいる。
        future = asyncio.run_coroutine_threadsafe(
            self._create_answer_async(session_id, offer),
            self._loop,
        )
        return future.result()


peer_manager = PeerManager()
