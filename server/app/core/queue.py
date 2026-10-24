import asyncio
import logging
from typing import Any, Callable
from collections import deque

from app.core.config import settings

logger = logging.getLogger(__name__)


class RequestQueue:
    """Async request queue for managing concurrent video resolutions."""

    def __init__(self, max_size: int | None = None):
        self._queue: deque = deque()
        self._max_size = max_size or settings.queue_max_size
        self._semaphore = asyncio.Semaphore(settings.max_concurrent_resolves)
        self._lock = asyncio.Lock()

    async def add(self, task_id: str, task: Callable) -> Any:
        """
        Add a task to the queue and wait for execution.

        Args:
            task_id: Unique identifier for the task
            task: Async callable to execute

        Returns:
            Result of the task execution

        Raises:
            QueueFullError: If queue is at capacity
        """
        async with self._lock:
            if len(self._queue) >= self._max_size:
                raise QueueFullError(f"Queue is full (max {self._max_size})")
            self._queue.append(task_id)
            logger.info(f"Added task {task_id} to queue (size: {len(self._queue)})")

        try:
            async with self._semaphore:
                logger.info(f"Executing task {task_id}")
                result = await task()
                return result
        finally:
            async with self._lock:
                if task_id in self._queue:
                    self._queue.remove(task_id)
                logger.info(f"Removed task {task_id} from queue (size: {len(self._queue)})")

    async def get_queue_size(self) -> int:
        """Get current queue size."""
        async with self._lock:
            return len(self._queue)

    async def clear(self) -> None:
        """Clear all pending tasks from the queue."""
        async with self._lock:
            self._queue.clear()
            logger.info("Queue cleared")


class QueueFullError(Exception):
    """Raised when queue is at capacity."""
    pass


# Global queue instance
request_queue = RequestQueue()
