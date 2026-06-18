import json
import uuid

from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt

from .media import peer_manager


@csrf_exempt
def offer(request):
    # ブラウザから最初に呼ばれるエンドポイント。
    # ここでは「camera を送りたい」という Offer を受け取って、backend 側の Answer を返す。
    if request.method != "POST":
        return JsonResponse({"detail": "Method not allowed."}, status=405)

    # リクエスト本文を JSON として読む。
    payload = json.loads(request.body.decode("utf-8"))
    # session_id がなければ新しく作る。
    # この ID で 1 つの接続を backend 側で管理する。
    session_id = payload.get("session_id") or str(uuid.uuid4())
    # browser が送った Offer 本体。
    offer_payload = payload["offer"]

    # aiortc 側で Answer を作る。
    # ここで backend は「この条件なら受けられる」と返す。
    answer = peer_manager.create_answer(session_id, offer_payload)

    return JsonResponse({
        "session_id": session_id,
        "answer": answer,
    })


@csrf_exempt
def close(request):
    # ブラウザから Stop 時に呼ばれるエンドポイント。
    # backend 側に残っている RTCPeerConnection を閉じる。
    if request.method != "POST":
        return JsonResponse({"detail": "Method not allowed."}, status=405)

    payload = json.loads(request.body.decode("utf-8"))
    session_id = payload.get("session_id")
    if session_id:
        peer_manager.close(session_id)
    return JsonResponse({"ok": True})
