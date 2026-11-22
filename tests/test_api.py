"""API tests for SpiderWeb using mocked httpx transport."""

from __future__ import annotations

import asyncio
import json
from typing import Any, Dict
from unittest.mock import patch

import httpx
import pytest
from fastapi.testclient import TestClient

from spiderweb.api import app, _jobs, _jobs_lock
from spiderweb.models import CrawlConfig


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

HTML_PAGE = """<html><head><title>Test Page</title></head>
<body><a href="/page1">Page 1</a></body></html>"""


def _clear_jobs() -> None:
    _jobs.clear()


@pytest.fixture(autouse=True)
def clear_jobs() -> None:
    _clear_jobs()
    yield
    _clear_jobs()


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


class MockTransport(httpx.MockTransport):
    def __init__(self, pages: Dict[str, str]) -> None:
        self._pages = pages

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        path = httpx.URL(url).path
        body = self._pages.get(path, self._pages.get("/", "<html></html>"))
        return httpx.Response(200, text=body, request=request)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_health(client: TestClient) -> None:
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_start_crawl(client: TestClient) -> None:
    pages = {
        "/": HTML_PAGE,
        "/page1": "<html><head><title>P1</title></head><body></body></html>",
    }

    with patch("spiderweb.crawler.httpx.AsyncClient") as mock_client_cls:
        mock_client = mock_client_cls.return_value.__aenter__.return_value

        async def mock_get(url, **kwargs):
            return httpx.Response(
                200,
                text=pages.get(httpx.URL(str(url)).path, "<html></html>"),
                request=httpx.Request("GET", url),
            )

        mock_client.get = mock_get

        resp = client.post(
            "/api/crawl",
            json={"url": "https://example.com/", "max_depth": 2, "max_pages": 10},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "job_id" in data
        assert data["status"] in ("queued", "running")


def test_start_crawl_missing_url(client: TestClient) -> None:
    resp = client.post("/api/crawl", json={})
    assert resp.status_code == 400


def test_start_crawl_blocks_private_ip(client: TestClient) -> None:
    resp = client.post("/api/crawl", json={"url": "http://127.0.0.1/"})
    assert resp.status_code == 400
    assert "Blocked IP" in resp.json()["detail"]


def test_start_crawl_blocks_metadata_ip(client: TestClient) -> None:
    resp = client.post("/api/crawl", json={"url": "http://169.254.169.254/"})
    assert resp.status_code == 400


def test_start_crawl_invalid_url(client: TestClient) -> None:
    resp = client.post("/api/crawl", json={"url": "ftp://example.com/"})
    assert resp.status_code == 400


def test_get_job_not_found(client: TestClient) -> None:
    resp = client.get("/api/jobs/nonexistent")
    assert resp.status_code == 404


def test_cancel_job(client: TestClient) -> None:
    pages = {"/": HTML_PAGE}

    with patch("spiderweb.crawler.httpx.AsyncClient") as mock_client_cls:
        mock_client = mock_client_cls.return_value.__aenter__.return_value

        async def mock_get(url, **kwargs):
            return httpx.Response(
                200, text=pages.get("/", "<html></html>"),
                request=httpx.Request("GET", url),
            )

        mock_client.get = mock_get

        resp = client.post("/api/crawl", json={"url": "https://example.com/", "max_pages": 1})
        assert resp.status_code == 200
        job_id = resp.json()["job_id"]

        cancel_resp = client.post(f"/api/jobs/{job_id}/cancel")
        assert cancel_resp.status_code == 200


def test_export_json(client: TestClient) -> None:
    pages = {"/": HTML_PAGE}

    with patch("spiderweb.crawler.httpx.AsyncClient") as mock_client_cls:
        mock_client = mock_client_cls.return_value.__aenter__.return_value

        async def mock_get(url, **kwargs):
            return httpx.Response(
                200, text=pages.get("/", "<html></html>"),
                request=httpx.Request("GET", url),
            )

        mock_client.get = mock_get

        resp = client.post("/api/crawl", json={"url": "https://example.com/", "max_pages": 1})
        assert resp.status_code == 200
        job_id = resp.json()["job_id"]

        # Wait a bit for the crawl to complete
        import time
        time.sleep(0.5)

        export_resp = client.get(f"/api/jobs/{job_id}/export?format=json")
        assert export_resp.status_code == 200
        data = export_resp.json()
        assert "pages" in data
        assert "total_pages" in data


def test_export_csv(client: TestClient) -> None:
    pages = {"/": HTML_PAGE}

    with patch("spiderweb.crawler.httpx.AsyncClient") as mock_client_cls:
        mock_client = mock_client_cls.return_value.__aenter__.return_value

        async def mock_get(url, **kwargs):
            return httpx.Response(
                200, text=pages.get("/", "<html></html>"),
                request=httpx.Request("GET", url),
            )

        mock_client.get = mock_get

        resp = client.post("/api/crawl", json={"url": "https://example.com/", "max_pages": 1})
        assert resp.status_code == 200
        job_id = resp.json()["job_id"]

        import time
        time.sleep(0.5)

        export_resp = client.get(f"/api/jobs/{job_id}/export?format=csv")
        assert export_resp.status_code == 200
        assert "text/csv" in export_resp.headers["content-type"]


def test_websocket_streams_events(client: TestClient) -> None:
    pages = {"/": HTML_PAGE}

    with patch("spiderweb.crawler.httpx.AsyncClient") as mock_client_cls:
        mock_client = mock_client_cls.return_value.__aenter__.return_value

        async def mock_get(url, **kwargs):
            return httpx.Response(
                200, text=pages.get("/", "<html></html>"),
                request=httpx.Request("GET", url),
            )

        mock_client.get = mock_get

        resp = client.post("/api/crawl", json={"url": "https://example.com/", "max_pages": 1})
        assert resp.status_code == 200
        job_id = resp.json()["job_id"]

        with client.websocket_connect(f"/ws/{job_id}") as websocket:
            # Receive events until finished
            received_any = False
            for _ in range(20):
                try:
                    msg = websocket.receive_text()
                    event = json.loads(msg)
                    received_any = True
                    if event.get("type") == "finished":
                        break
                except Exception:
                    break
            assert received_any, "No events received over WebSocket"


def test_websocket_nonexistent_job(client: TestClient) -> None:
    with client.websocket_connect("/ws/nonexistent") as websocket:
        # Should close with 4004
        pass
