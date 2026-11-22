"""URL normalization, dedupe, and domain helpers."""

from __future__ import annotations

from urllib.parse import urljoin, urlparse, urlunparse, parse_qsl, urlencode

from typing import Optional, Set


def normalize_url(url: str) -> Optional[str]:
    """Normalize a URL for dedupe.

    - Strip fragments
    - Sort query parameters
    - Lowercase scheme and host
    - Remove default ports
    - Drop trailing slash on path (keep root)
    Returns None for non-HTTP(S) schemes.
    """
    try:
        parsed = urlparse(url.strip())
    except ValueError:
        return None

    scheme = parsed.scheme.lower()
    if scheme not in ("http", "https"):
        return None

    netloc = parsed.hostname or ""
    if parsed.port:
        netloc += f":{parsed.port}"

    path = parsed.path or "/"
    if path != "/" and path.endswith("/"):
        path = path.rstrip("/")

    # Sort query params for stable dedupe
    query = urlencode(sorted(parse_qsl(parsed.query, keep_blank_values=True)))

    normalized = urlunparse((scheme, netloc, path, "", query, ""))
    return normalized


def is_valid_crawl_url(url: str) -> bool:
    """Return True if the URL is a crawlable HTTP(S) URL (not mailto/tel/javascript/etc)."""
    return normalize_url(url) is not None


def same_domain(url_a: str, url_b: str, include_subdomains: bool = False) -> bool:
    """Check if two URLs share the same domain.

    If include_subdomains is True, example.com matches www.example.com and
    sub.example.com. Otherwise they must match exactly.
    """
    a = urlparse(url_a)
    b = urlparse(url_b)
    if not a.hostname or not b.hostname:
        return False

    host_a = a.hostname.lower()
    host_b = b.hostname.lower()

    if host_a == host_b:
        return True

    if include_subdomains:
        # Check if one is a subdomain of the other
        for longer, shorter in ((host_a, host_b), (host_b, host_a)):
            if longer.endswith("." + shorter):
                return True

    return False


def extract_links(html: str, base_url: str) -> list[str]:
    """Extract and normalize all crawlable links from HTML relative to base_url."""
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")
    links: Set[str] = set()

    for tag in soup.find_all("a", href=True):
        href = tag["href"].strip()
        if not href:
            continue
        if href.startswith(("mailto:", "tel:", "javascript:")):
            continue
        absolute = urljoin(base_url, href)
        normalized = normalize_url(absolute)
        if normalized:
            links.add(normalized)

    return sorted(links)
