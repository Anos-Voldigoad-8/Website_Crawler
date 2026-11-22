"""Unit tests for SpiderWeb crawler using mocked httpx transport."""

from __future__ import annotations

from typing import Any, Dict, List
from unittest.mock import patch

import httpx
import pytest

from spiderweb.crawler import Crawler, is_blocked_ip
from spiderweb.models import CrawlConfig
from spiderweb.urlutils import normalize_url, is_valid_crawl_url, same_domain, extract_links


# ---------------------------------------------------------------------------
# urlutils tests
# ---------------------------------------------------------------------------

def test_normalize_url_strips_fragment_and_sorts_query() -> None:
    assert normalize_url("https://example.com/page?b=2&a=1#section") == \
        "https://example.com/page?a=1&b=2"


def test_normalize_url_rejects_non_http() -> None:
    assert normalize_url("mailto:test@example.com") is None
    assert normalize_url("tel:+1234567890") is None
    assert normalize_url("javascript:alert(1)") is None


def test_normalize_url_lowercases_scheme_and_host() -> None:
    assert normalize_url("HTTPS://Example.COM/Page") == "https://example.com/Page"


def test_same_domain_exact() -> None:
    assert same_domain("https://example.com/a", "https://example.com/b") is True


def test_same_domain_different() -> None:
    assert same_domain("https://example.com/a", "https://other.com/b") is False


def test_same_domain_with_subdomains() -> None:
    assert same_domain("https://example.com/a", "https://www.example.com/b", include_subdomains=True) is True
    assert same_domain("https://example.com/a", "https://www.example.com/b", include_subdomains=False) is False


def test_extract_links_ignores_non_http() -> None:
    html = '<a href="https://example.com/a">A</a><a href="mailto:x@y.com">M</a><a href="tel:123">T</a><a href="javascript:;">J</a>'
    links = extract_links(html, "https://example.com/")
    assert "https://example.com/a" in links
    assert not any("mailto" in l or "tel" in l or "javascript" in l for l in links)


# ---------------------------------------------------------------------------
# SSRF tests
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("host", [
    "127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1",
    "169.254.169.254", "0.0.0.0", "224.0.0.1",
    "::1", "fc00::1", "fe80::1",
])
def test_is_blocked_ip_private(host: str) -> None:
    assert is_blocked_ip(host) is True


@pytest.mark.parametrize("host", ["93.184.216.34", "1.1.1.1", "8.8.8.8", "2001:4860:4860::8888"])
def test_is_blocked_ip_public(host: str) -> None:
    assert is_blocked_ip(host) is False


def test_is_blocked_ip_not_ip() -> None:
    assert is_blocked_ip("example.com") is False


# ---------------------------------------------------------------------------
# Crawler tests with mocked transport
# ---------------------------------------------------------------------------

HTML_PAGE = """<html><head><title>Test Page</title></head>
<body>
<a href="/page1">Page 1</a>
<a href="https://example.com/page2">Page 2</a>
<a href="mailto:test@example.com">Mail</a>
</body></html>"""


class MockTransport(httpx.MockTransport):
    """Simple mock transport returning HTML for example.com URLs."""

    def __init__(self, pages: Dict[str, str]) -> None:
        self._pages = pages

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        path = httpx.URL(url).path
        body = self._pages.get(path, self._pages.get("/", "<html><body>Not found</body></html>"))
        return httpx.Response(200, text=body, request=request)


@pytest.mark.asyncio
async def test_crawl_basic() -> None:
    pages = {
        "/": HTML_PAGE,
        "/page1": "<html><head><title>Page 1</title></head><body><a href='/'>Home</a></body></html>",
        "/page2": "<html><head><title>Page 2</title></head><body></body></html>",
    }

    with patch("spiderweb.crawler.httpx.AsyncClient") as mock_client_cls:
        mock_client = mock_client_cls.return_value.__aenter__.return_value

        async def mock_get(url, **kwargs):
            return httpx.Response(200, text=pages.get(httpx.URL(str(url)).path, "<html></html>"), request=httpx.Request("GET", url))

        mock_client.get = mock_get

        config = CrawlConfig(start_url="https://example.com/", max_depth=2, max_pages=10, concurrency=2)
        crawler = Crawler(config)

        events = []
        async for event in crawler.crawl():
            events.append(event)

        fetched = [e for e in events if e.type == "page_fetched"]
        assert len(fetched) >= 1
        assert any(e.page and e.page.url == "https://example.com/" for e in fetched)


@pytest.mark.asyncio
async def test_crawl_respects_max_pages() -> None:
    pages = {
        "/": HTML_PAGE,
        "/page1": "<html><head><title>P1</title></head><body></body></html>",
        "/page2": "<html><head><title>P2</title></head><body></body></html>",
    }

    with patch("spiderweb.crawler.httpx.AsyncClient") as mock_client_cls:
        mock_client = mock_client_cls.return_value.__aenter__.return_value

        async def mock_get(url, **kwargs):
            return httpx.Response(200, text=pages.get(httpx.URL(str(url)).path, "<html></html>"), request=httpx.Request("GET", url))

        mock_client.get = mock_get

        config = CrawlConfig(start_url="https://example.com/", max_depth=2, max_pages=2, concurrency=2)
        crawler = Crawler(config)

        events = []
        async for event in crawler.crawl():
            events.append(event)

        fetched = [e for e in events if e.type == "page_fetched"]
        assert len(fetched) <= 2


@pytest.mark.asyncio
async def test_crawl_blocks_private_ip() -> None:
    config = CrawlConfig(start_url="http://127.0.0.1/", max_depth=1, max_pages=10)
    crawler = Crawler(config)

    events = []
    async for event in crawler.crawl():
        events.append(event)

    errors = [e for e in events if e.type == "error"]
    assert any("Blocked IP" in (e.message or "") for e in errors)


@pytest.mark.asyncio
async def test_crawl_yields_finished() -> None:
    with patch("spiderweb.crawler.httpx.AsyncClient") as mock_client_cls:
        mock_client = mock_client_cls.return_value.__aenter__.return_value

        async def mock_get(url, **kwargs):
            return httpx.Response(200, text="<html></html>", request=httpx.Request("GET", url))

        mock_client.get = mock_get

        config = CrawlConfig(start_url="https://example.com/", max_depth=1, max_pages=1)
        crawler = Crawler(config)

        events = []
        async for event in crawler.crawl():
            events.append(event)

    assert any(e.type == "finished" for e in events)
