from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_endpoint():
    """Test the health check endpoint."""
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"


def test_health_endpoint_not_rate_limited():
    """Test that health endpoint is not rate limited."""
    # Make multiple requests quickly
    for _ in range(20):
        response = client.get("/health")
        assert response.status_code == 200
