import pytest

from app.utils.url_validation import URLValidationError, validate_installation_id, validate_url


def test_valid_url():
    """Test validation of a valid URL."""
    url = "https://www.youtube.com/watch?v=test"
    result = validate_url(url)
    assert result == url


def test_url_with_credentials():
    """Test that URLs with credentials are rejected."""
    url = "https://user:pass@example.com/video"
    with pytest.raises(URLValidationError) as exc_info:
        validate_url(url)
    assert exc_info.value.code == "INVALID_URL"
    assert "credentials" in exc_info.value.message.lower()


def test_invalid_scheme():
    """Test that non-HTTP/HTTPS schemes are rejected."""
    url = "ftp://example.com/video"
    with pytest.raises(URLValidationError) as exc_info:
        validate_url(url)
    assert exc_info.value.code == "INVALID_URL"
    assert "scheme" in exc_info.value.message.lower()


def test_localhost_rejected():
    """Test that localhost is rejected."""
    url = "http://localhost:8000/video"
    with pytest.raises(URLValidationError) as exc_info:
        validate_url(url)
    assert exc_info.value.code == "INVALID_URL"
    assert "localhost" in exc_info.value.message.lower()


def test_private_ip_rejected():
    """Test that private IP addresses are rejected."""
    url = "http://192.168.1.1/video"
    with pytest.raises(URLValidationError) as exc_info:
        validate_url(url)
    assert exc_info.value.code == "INVALID_URL"
    assert "private" in exc_info.value.message.lower()


def test_cloud_metadata_rejected():
    """Test that cloud metadata endpoints are rejected."""
    url = "http://169.254.169.254/video"
    with pytest.raises(URLValidationError) as exc_info:
        validate_url(url)
    assert exc_info.value.code == "INVALID_URL"


def test_empty_url():
    """Test that empty URLs are rejected."""
    with pytest.raises(URLValidationError) as exc_info:
        validate_url("")
    assert exc_info.value.code == "INVALID_URL"


def test_valid_installation_id():
    """Test validation of a valid installation ID."""
    assert validate_installation_id("abc123def456ghi789") is True


def test_invalid_installation_id_too_short():
    """Test that installation IDs below minimum length are rejected."""
    assert validate_installation_id("short") is False


def test_invalid_installation_id_too_long():
    """Test that installation IDs above maximum length are rejected."""
    long_id = "a" * 200
    assert validate_installation_id(long_id) is False


def test_invalid_installation_id_special_chars():
    """Test that installation IDs with special characters are rejected."""
    assert validate_installation_id("abc@123") is False


def test_none_installation_id():
    """Test that None installation ID is rejected."""
    assert validate_installation_id(None) is False
