from django.urls import path
from . import views

urlpatterns = [
    path("offer/send/", views.offer_send, name="webrtc-offer-send"),
    path("offer/view/", views.offer_view, name="webrtc-offer-view"),
    path("pose/update/", views.pose_update, name="webrtc-pose-update"),
    path("pose/latest/", views.pose_latest, name="webrtc-pose-latest"),
    path("close/", views.close, name="webrtc-close"),
]