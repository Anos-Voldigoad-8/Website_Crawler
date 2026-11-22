"""Async BFS crawler core with SSRF protection and robots.txt support."""

from __future__ import annotations

import asyncio
import ipaddress
import time
from collections import deque
from typing import AsyncGenerator, Optional

import httpx
from selectolax.lexbor import LexborHTMLParser as HTMLParser

from .models import CrawlConfig, CrawlEvent, CrawlEventType, PageRecord
from .robots import RobotsChecker
from .urlutils import extract_links, is_valid_crawl_url, normalize_url, same_domain


# Private / internal IP ranges to block (SSRF protection)
BLOCKED_NETWORKS = [
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),  # cloud metadata
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("224.0.0.0/4"),  # multicast
    ipaddress.ip_network("::1/128"),  # IPv6 loopback
    ipaddress.ip_network("fc00::/7"),  # IPv6 unique local
    ipaddress.ip_network("fe80::/10"),  # IPv6 link-local
]


def is_blocked_ip(host: str) -> bool:
    """Return True if the host is a literal blocked/private IP address."""
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        # Not a literal IP; DNS resolution will be checked at fetch time
        return False
    return any(ip in net for net in BLOCKED_NETWORKS)


def urlparse_host(url: str) -> Optional[str]:
    """Extract the hostname from a URL string."""
    from urllib.parse import urlparse

    try:
        return urlparse(url).hostname
    except Exception:  # noqa: BLE001
        return None


class Crawler:
    """Async BFS crawler yielding CrawlEvent objects."""

    def __init__(self, config: CrawlConfig) -> None:
        self.config = config
        self._job_id = str(config.start_url.host or "unknown")
        self._visited: set[str] = set()
        self._queue: deque[tuple[str, int, Optional[str]]] = deque()
        self._host_last_request: dict[str, float] = {}
        self._host_locks: dict[str, asyncio.Lock] = {}
        self._semaphore = asyncio.Semaphore(config.concurrency)
        self._pages_fetched = 0
        self._cancelled = False

    @property
    def job_id(self) -> str:
        return self._job_id

    def cancel(self) -> None:
        self._cancelled = True

    async def crawl(self) -> AsyncGenerator[CrawlEvent, None]:
        """Run the crawl, yielding events."""
        start_url = str(self.config.start_url)
        normalized = normalize_url(start_url)
        if not normalized:
            yield CrawlEvent(
                type=CrawlEventType.ERROR,
                message=f"Invalid start URL: {start_url}",
            )
            yield CrawlEvent(type=CrawlEventType.FINISHED)
            return

        # SSRF check on start URL host
        parsed_start = urlparse_host(normalized)
        if parsed_start and is_blocked_ip(parsed_start):
            yield CrawlEvent(
                type=CrawlEventType.ERROR,
                message=f"Blocked IP address: {parsed_start}",
            )
            yield CrawlEvent(type=CrawlEventType.FINISHED)
            return

        self._queue.append((normalized, 0, None))
        self._visited.add(normalized)
        yield CrawlEvent(
            type=CrawlEventType.PAGE_DISCOVERED,
            page=PageRecord(url=normalized, depth=0, parent_url=None),
        )

        async with httpx.AsyncClient(
            headers={"User-Agent": self.config.user_agent},
            follow_redirects=True,
            timeout=self.config.request_timeout,
        ) as client:
            robots = RobotsChecker(
                client,
                self.config.user_agent,
                self.config.respect_robots,
                self.config.request_timeout,
            )

            while self._queue and not self._cancelled:
                if self._pages_fetched >= self.config.max_pages:
                    break

                url, depth, parent_url = self._queue.popleft()

                if depth > self.config.max_depth:
                    continue

                # Robots check
                if not await robots.async_is_allowed(url):
                    yield CrawlEvent(
                        type=CrawlEventType.ERROR,
                        message=f"Blocked by robots.txt: {url}",
                        parent_url=parent_url,
                    )
                    continue

                # Fetch with concurrency limit
                async with self._semaphore:
                    async for event in self._fetch_page(
                        client, robots, url, depth, parent_url
                    ):
                        yield event

        yield CrawlEvent(type=CrawlEventType.FINISHED)

    async def _fetch_page(
        self,
        client: httpx.AsyncClient,
        robots: RobotsChecker,
        url: str,
        depth: int,
        parent_url: Optional[str],
    ) -> AsyncGenerator[CrawlEvent, None]:
        """Fetch a single page and yield events for it and its discovered links."""
        start = time.perf_counter()
        record = PageRecord(url=url, depth=depth, parent_url=parent_url)

        try:
            resp = await client.get(url)
            elapsed_ms = (time.perf_counter() - start) * 1000

            # SSRF re-check after redirect
            final_url = str(resp.url)
            final_host = urlparse_host(final_url)
            if final_host and is_blocked_ip(final_host):
                record.error = f"Blocked IP address after redirect: {final_host}"
                self._pages_fetched += 1
                yield CrawlEvent(type=CrawlEventType.PAGE_FETCHED, page=record)
                return

            record.status_code = resp.status_code
            record.content_type = resp.headers.get("content-type", "")
            record.response_time_ms = round(elapsed_ms, 2)

            content_type = record.content_type or ""
            is_html = "text/html" in content_type

            if not is_html:
                record.error = f"Non-HTML content type: {content_type}"
                self._pages_fetched += 1
                yield CrawlEvent(type=CrawlEventType.PAGE_FETCHED, page=record)
                return

            html = resp.text
            record.title = self._extract_title(html)

            links = extract_links(html, final_url)
            record.outgoing_links = links

            for link in links:
                if self._cancelled:
                    break
                if not same_domain(final_url, link, self.config.same_subdomain):
                    continue
                if depth + 1 > self.config.max_depth:
                    continue
                if link in self._visited:
                    continue

                # SSRF check on discovered link host
                link_host = urlparse_host(link)
                if link_host and is_blocked_ip(link_host):
                    continue

                self._visited.add(link)
                self._queue.append((link, depth + 1, final_url))
                yield CrawlEvent(
                    type=CrawlEventType.LINK_FOUND,
                    link=link,
                    parent_url=final_url,
                )
                yield CrawlEvent(
                    type=CrawlEventType.PAGE_DISCOVERED,
                    page=PageRecord(url=link, depth=depth + 1, parent_url=final_url),
                )

            self._pages_fetched += 1
            yield CrawlEvent(type=CrawlEventType.PAGE_FETCHED, page=record)

        except httpx.HTTPError as exc:
            record.error = str(exc)
            self._pages_fetched += 1
            yield CrawlEvent(type=CrawlEventType.PAGE_FETCHED, page=record)
        except Exception as exc:  # noqa: BLE001
            record.error = str(exc)
            self._pages_fetched += 1
            yield CrawlEvent(type=CrawlEventType.PAGE_FETCHED, page=record)

    @staticmethod
    def _extract_title(html: str) -> Optional[str]:
        try:
            tree = HTMLParser(html)
            title_tag = tree.css_first("title")
            if title_tag:
                return title_tag.text().strip() or None
        except Exception:  # noqa: BLE001
            return None
        return None
