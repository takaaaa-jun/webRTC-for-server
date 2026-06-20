from __future__ import annotations

import asyncio
import copy
import threading
import uuid
from dataclasses import dataclass
from typing import Any, Dict, Optional

from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.contrib.media import MediaRelay
from aiortc.mediastreams import VideoStreamTrack


def _start_loop() -> asyncio.AbstractEventLoop:
    loop = asyncio.new_event_loop()

    def run() -> None:
        asyncio.set_event_loop(loop)
        loop.run_forever()

    threading.Thread(target=run, daemon=True).start()
    return loop


AIORTC_LOOP = _start_loop()
RELAY = MediaRelay()


@dataclass
class RoomState:
    sender_session_id: Optional[str] = None
    source_track: Optional[VideoStreamTrack] = None
    latest_pose: Optional[Dict[str, Any]] = None


@dataclass
class SessionState:
    room_id: str
    role: str
    pc: RTCPeerConnection
    proxy_track: Optional[VideoStreamTrack] = None


async def wait_for_ice_gathering_complete(pc: RTCPeerConnection) -> None:
    while pc.iceGatheringState != "complete":
        await asyncio.sleep(0.05)


class PeerManager:
    def __init__(self) -> None:
        self._loop = AIORTC_LOOP
        self._lock = threading.Lock()
        self._rooms: Dict[str, RoomState] = {}
        self._sessions: Dict[str, SessionState] = {}

    def _get_room(self, room_id: str) -> RoomState:
        with self._lock:
            room = self._rooms.get(room_id)
            if room is None:
                room = RoomState()
                self._rooms[room_id] = room
            return room

    async def _close_session_async(self, session_id: str) -> None:
        with self._lock:
            session = self._sessions.pop(session_id, None)
        if session is None:
            return

        room = self._get_room(session.room_id)
        if session.role == "send" and room.sender_session_id == session_id:
            room.sender_session_id = None
            room.source_track = None
            room.latest_pose = None

        await session.pc.close()

    def close(self, session_id: str) -> None:
        if not session_id:
            return
        future = asyncio.run_coroutine_threadsafe(
            self._close_session_async(session_id),
            self._loop,
        )
        future.result()

    async def _create_sender_answer_async(self, room_id: str, session_id: str, offer: dict) -> dict:
        await self._close_session_async(session_id)

        pc = RTCPeerConnection()
        room = self._get_room(room_id)
        session = SessionState(room_id=room_id, role="send", pc=pc)
        with self._lock:
            self._sessions[session_id] = session
        room.sender_session_id = session_id

        @pc.on("track")
        def on_track(track) -> None:
            if track.kind == "video":
                room.source_track = track

        @pc.on("connectionstatechange")
        async def on_connectionstatechange() -> None:
            if pc.connectionState in {"failed", "closed", "disconnected"}:
                await self._close_session_async(session_id)

        await pc.setRemoteDescription(
            RTCSessionDescription(sdp=offer["sdp"], type=offer["type"])
        )
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        await wait_for_ice_gathering_complete(pc)
        return {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type}

    async def _create_viewer_answer_async(self, room_id: str, session_id: str, offer: dict) -> dict:
        room = self._get_room(room_id)
        if room.source_track is None:
            raise RuntimeError("Source track is not ready yet.")

        await self._close_session_async(session_id)

        pc = RTCPeerConnection()
        session = SessionState(room_id=room_id, role="view", pc=pc)
        with self._lock:
            self._sessions[session_id] = session

        proxy_track = RELAY.subscribe(room.source_track)
        session.proxy_track = proxy_track
        pc.addTrack(proxy_track)

        @pc.on("connectionstatechange")
        async def on_connectionstatechange() -> None:
            if pc.connectionState in {"failed", "closed", "disconnected"}:
                await self._close_session_async(session_id)

        await pc.setRemoteDescription(
            RTCSessionDescription(sdp=offer["sdp"], type=offer["type"])
        )
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        await wait_for_ice_gathering_complete(pc)
        return {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type}

    def create_sender_answer(self, room_id: str, session_id: str, offer: dict) -> dict:
        future = asyncio.run_coroutine_threadsafe(
            self._create_sender_answer_async(room_id, session_id, offer),
            self._loop,
        )
        return future.result()

    def create_viewer_answer(self, room_id: str, session_id: str, offer: dict) -> dict:
        future = asyncio.run_coroutine_threadsafe(
            self._create_viewer_answer_async(room_id, session_id, offer),
            self._loop,
        )
        return future.result()

    def update_pose(self, room_id: str, pose_payload: Dict[str, Any]) -> None:
        room = self._get_room(room_id)
        with self._lock:
            room.latest_pose = copy.deepcopy(pose_payload)

    def get_latest_pose(self, room_id: str) -> Optional[Dict[str, Any]]:
        room = self._get_room(room_id)
        with self._lock:
            if room.latest_pose is None:
                return None
            return copy.deepcopy(room.latest_pose)

    def new_session_id(self) -> str:
        return str(uuid.uuid4())


peer_manager = PeerManager()
