import time

from app.core.rate_limit import rate_limiter


def test_rate_limit_within_quota():
    """Test that requests within quota are allowed."""
    rate_limiter.reset()
    allowed, retry_after = rate_limiter.check_rate_limit("test-client", "127.0.0.1")
    assert allowed is True
    assert retry_after is None


def test_rate_limit_exceeded():
    """Test that requests exceeding quota are blocked."""
    from app.core.config import settings

    rate_limiter.reset()
    client_id = "test-client-2"

    # Make requests up to the limit
    for _ in range(settings.rate_limit_requests):
        allowed, retry_after = rate_limiter.check_rate_limit(client_id, "127.0.0.1")
        assert allowed is True

    # Next request should be rate limited
    allowed, retry_after = rate_limiter.check_rate_limit(client_id, "127.0.0.1")
    assert allowed is False
    assert retry_after is not None
    assert retry_after > 0


def test_rate_limit_different_clients():
    """Test that rate limits are per-client."""
    from app.core.config import settings

    rate_limiter.reset()
    # Exhaust quota for client 1 with different IP
    for _ in range(settings.rate_limit_requests):
        rate_limiter.check_rate_limit("client-1", "127.0.0.1")

    # Client 2 with different IP should still be allowed
    allowed, _retry_after = rate_limiter.check_rate_limit("client-2", "127.0.0.2")
    assert allowed is True


def test_rate_limit_ip_fallback():
    """Test that IP-based limiting works when no installation ID."""
    from app.core.config import settings

    rate_limiter.reset()
    # Exhaust quota for an IP
    for _ in range(settings.rate_limit_requests):
        rate_limiter.check_rate_limit(None, "192.168.1.100")

    # Same IP should be blocked
    allowed, _retry_after = rate_limiter.check_rate_limit(None, "192.168.1.100")
    assert allowed is False


def test_rate_limit_reset():
    """Test that rate limits can be reset."""
    from app.core.config import settings

    rate_limiter.reset()
    client_id = "test-client-3"

    # Exhaust quota
    for _ in range(settings.rate_limit_requests):
        rate_limiter.check_rate_limit(client_id, "127.0.0.1")

    # Should be blocked
    allowed, _ = rate_limiter.check_rate_limit(client_id, "127.0.0.1")
    assert allowed is False

    # Reset
    rate_limiter.reset()

    # Should be allowed again
    allowed, retry_after = rate_limiter.check_rate_limit(client_id, "127.0.0.1")
    assert allowed is True
    assert retry_after is None


def test_rate_limit_cleanup_old_entries():
    """Test that old entries are cleaned up."""

    rate_limiter.reset()
    client_id = "test-client-4"

    # Make a request
    rate_limiter.check_rate_limit(client_id, "127.0.0.1")

    # Manually set timestamp to old
    from app.core.rate_limit import rate_limiter as limiter
    old_time = time.time() - 1000  # Very old
    if client_id in limiter._requests:
        limiter._requests[client_id][0] = old_time

    # Make another request - should clean up old entry
    allowed, _retry_after = rate_limiter.check_rate_limit(client_id, "127.0.0.1")
    assert allowed is True
