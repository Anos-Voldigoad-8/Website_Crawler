"""robots.txt handling with optional override."""

from __future__ import annotations

import asyncio
from typing import Optional
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser

import httpx


class RobotsChecker:
    """Checks robots.txt rules for a given host, caching parsed results."""

    def __init__(
        self,
        client: httpx.AsyncClient,
        user_agent: str,
        respect_robots: bool = True,
        request_timeout: float = 30.0,
    ) -> None:
        self._client = client
        self._user_agent = user_agent
        self._respect_robots = respect_robots
        self._request_timeout = request_timeout
        self._cache: dict[str, Optional[RobotFileParser]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    def is_allowed(self, url: str) -> bool:
        """Synchronous check. Returns True if robots are disabled or URL is allowed."""
        if not self._respect_robots:
            return True

        parsed = urlparse(url)
        host = f"{parsed.scheme}://{parsed.netloc}"

        rp = self._cache.get(host)
        if rp is None:
            # Not yet fetched; default to allowing to avoid blocking on unknown
            return True
        if rp is False:
            # Explicitly marked as not fetchable (e.g. 404) -> allow
            return True
        return rp.can_fetch(self._user_agent, url)

    async def async_is_allowed(self, url: str) -> bool:
        """Async check: fetch robots.txt if not cached, then decide."""
        if not self._respect_robots:
            return True

        parsed = urlparse(url)
        host = f"{parsed.scheme}://{parsed.netloc}"

        if host in self._cache:
            rp = self._cache[host]
            if rp is False:
                return True
            return rp.can_fetch(self._user_agent, url)

        lock = self._locks.setdefault(host, asyncio.Lock())
        async with lock:
            # Re-check after acquiring lock
            if host in self._cache:
                rp = self._cache[host]
                if rp is False:
                    return True
                return rp.can_fetch(self._user_agent, url)

            rp = await self._fetch_robots(host)
            self._cache[host] = rp
            if rp is False:
                return True
            return rp.can_fetch(self._user_agent, url)

    async def _fetch_robots(self, host: str) -> Optional[RobotFileParser]:
        """Fetch and parse robots.txt for a host. Returns False if not fetchable."""
        robots_url = host.rstrip("/") + "/robots.txt"
        rp = RobotFileParser()
        rp.set_url(robots_url)
        try:
            resp = await self._client.get(robots_url, timeout=self._request_timeout)
            if resp.status_code >= 400:
                # Treat 404/4xx as "no robots.txt" -> allow all
                return False
            rp.parse(resp.text.splitlines())
            return rp
        except Exception:
            # Network error -> fail open (allow)
            return False
