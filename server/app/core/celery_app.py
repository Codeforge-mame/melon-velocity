import os

from celery import Celery

broker_url = os.getenv("CELERY_BROKER_URL", "redis://localhost:6379/0")
result_backend = os.getenv("CELERY_RESULT_BACKEND", broker_url)

celery_app = Celery(
    "melostream",
    broker=broker_url,
    backend=result_backend,
    include=["app.services.tasks"],
)
celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    task_track_started=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    worker_concurrency=2,
    result_expires=3600,
)
