from django.urls import path

from . import views

urlpatterns = [
    path("offer/", views.offer, name="webrtc-offer"),
    path("close/", views.close, name="webrtc-close"),
]
