from __future__ import annotations

import json
import uuid

from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt

from .media import peer_manager


def _json_body(request):
    return json.loads(request.body.decode("utf-8")) if request.body else {}


@csrf_exempt
def offer_send(request):
    if request.method != "POST":
        return JsonResponse({"detail": "Method not allowed."}, status=405)

    payload = _json_body(request)
    session_id = payload.get("session_id") or str(uuid.uuid4())
    room_id = payload.get("room_id") or "default"
    offer_payload = payload["offer"]

    answer = peer_manager.create_sender_answer(room_id, session_id, offer_payload)
    return JsonResponse({"session_id": session_id, "room_id": room_id, "answer": answer})


@csrf_exempt
def offer_view(request):
    if request.method != "POST":
        return JsonResponse({"detail": "Method not allowed."}, status=405)

    payload = _json_body(request)
    session_id = payload.get("session_id") or str(uuid.uuid4())
    room_id = payload.get("room_id") or "default"
    offer_payload = payload["offer"]

    try:
        answer = peer_manager.create_viewer_answer(room_id, session_id, offer_payload)
    except RuntimeError as exc:
        return JsonResponse({"detail": str(exc)}, status=409)

    return JsonResponse({"session_id": session_id, "room_id": room_id, "answer": answer})


@csrf_exempt
def pose_update(request):
    if request.method != "POST":
        return JsonResponse({"detail": "Method not allowed."}, status=405)

    payload = _json_body(request)
    room_id = payload.get("room_id") or "default"
    peer_manager.update_pose(room_id, payload)
    return JsonResponse({"ok": True, "room_id": room_id})


def pose_latest(request):
    if request.method != "GET":
        return JsonResponse({"detail": "Method not allowed."}, status=405)

    room_id = request.GET.get("room_id") or "default"
    pose_payload = peer_manager.get_latest_pose(room_id)

    if pose_payload is None:
        return JsonResponse({"ready": False, "room_id": room_id})

    return JsonResponse({"ready": True, "room_id": room_id, "pose": pose_payload})


@csrf_exempt
def close(request):
    if request.method != "POST":
        return JsonResponse({"detail": "Method not allowed."}, status=405)

    payload = _json_body(request)
    session_id = payload.get("session_id")
    if session_id:
        peer_manager.close(session_id)
    return JsonResponse({"ok": True})
