import ipaddress
import re
from urllib.parse import urlparse, urlunparse


class URLValidationError(Exception):
    """Raised when URL validation fails."""

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


# Reserved IP ranges to block
RESERVED_IP_RANGES = [
    # Loopback
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("::1/128"),
    # Link-local
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("fe80::/10"),
    # Private networks
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("fc00::/7"),
    # Cloud metadata endpoints (AWS, GCP, Azure)
    "169.254.169.254",
    "metadata.google.internal",
]


def is_reserved_ip(hostname: str) -> bool:
    """Check if hostname resolves to a reserved/private IP."""
    try:
        # Check if it's a literal IP address
        addr = ipaddress.ip_address(hostname)
        for network in RESERVED_IP_RANGES:
            if isinstance(network, ipaddress._BaseNetwork) and addr in network:
                return True
        return False
    except ValueError:
        # Not a literal IP, check hostname patterns
        for reserved in RESERVED_IP_RANGES:
            if isinstance(reserved, str) and hostname == reserved:
                return True
        return False


def validate_url(url: str) -> str:
    """
    Validate a URL for video resolution.

    Args:
        url: The URL to validate

    Returns:
        The normalized URL if valid

    Raises:
        URLValidationError: If the URL is invalid or unsafe
    """
    if not url or not isinstance(url, str):
        raise URLValidationError("INVALID_URL", "URL must be a non-empty string")

    url = url.strip()

    # Check for credentials in URL
    if "://" in url and "@" in url.split("://")[1]:
        raise URLValidationError("INVALID_URL", "URL must not contain credentials")

    try:
        parsed = urlparse(url)
    except (ValueError, TypeError) as e:
        raise URLValidationError("INVALID_URL", f"Invalid URL format: {e!s}")

    # Only allow HTTP and HTTPS
    if parsed.scheme not in ("http", "https"):
        raise URLValidationError(
            "INVALID_URL", f"Unsupported scheme: {parsed.scheme}. Only http and https are allowed"
        )

    # Require a hostname
    if not parsed.hostname:
        raise URLValidationError("INVALID_URL", "URL must include a hostname")

    # Block localhost and reserved IPs
    hostname = parsed.hostname.lower()
    if hostname in ("localhost", "127.0.0.1", "::1", "0.0.0.0"):
        raise URLValidationError("INVALID_URL", "Localhost addresses are not allowed")

    if is_reserved_ip(hostname):
        raise URLValidationError("INVALID_URL", "Private network addresses are not allowed")

    # Block cloud metadata endpoints
    if hostname in ("169.254.169.254", "metadata.google.internal"):
        raise URLValidationError("INVALID_URL", "Cloud metadata endpoints are not allowed")

    # Normalize the URL (remove fragments, etc.)
    normalized = urlunparse(
        (parsed.scheme, parsed.netloc, parsed.path, "", parsed.query, "")
    )

    return normalized


def validate_installation_id(installation_id: str | None) -> bool:
    """
    Validate the installation ID header format.

    Args:
        installation_id: The X-Installation-ID header value

    Returns:
        True if valid, False otherwise
    """
    from app.core.config import settings

    if not installation_id or not isinstance(installation_id, str):
        return False

    length = len(installation_id)
    if length < settings.installation_id_min_length or length > settings.installation_id_max_length:
        return False

    # Check for reasonable characters (alphanumeric, hyphens, underscores)
    return bool(re.match(r"^[a-zA-Z0-9_-]+$", installation_id))
