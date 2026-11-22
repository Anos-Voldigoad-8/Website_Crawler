"""Command-line interface for SpiderWeb."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from typing import List

import asyncio

from .crawler import Crawler
from .models import CrawlConfig


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="spiderweb",
        description="Async website crawler with cyberpunk visualization.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    crawl = sub.add_parser("crawl", help="Crawl a website")
    crawl.add_argument("url", help="Start URL")
    crawl.add_argument("--depth", type=int, default=3, help="Max depth")
    crawl.add_argument("--max-pages", type=int, default=200, help="Max pages")
    crawl.add_argument("--concurrency", type=int, default=10, help="Concurrent requests")
    crawl.add_argument("--per-host-delay", type=float, default=1.0, help="Delay per host (s)")
    crawl.add_argument("--timeout", type=float, default=30.0, help="Request timeout (s)")
    crawl.add_argument("--max-retries", type=int, default=3, help="Max retries")
    crawl.add_argument("--user-agent", default="SpiderWeb/1.0", help="Custom User-Agent")
    crawl.add_argument(
        "--same-subdomain", action="store_true", help="Include subdomains"
    )
    crawl.add_argument(
        "--no-robots", action="store_true", help="Ignore robots.txt"
    )
    crawl.add_argument("--out", default="result.json", help="Output JSON file")
    crawl.add_argument(
        "--csv", default=None, help="Also export CSV to this path"
    )
    crawl.add_argument(
        "--broken-links-report", default=None, help="Write broken-links report to this path"
    )

    return parser


async def run_crawl(args: argparse.Namespace) -> None:
    config = CrawlConfig(
        start_url=args.url,
        max_depth=args.depth,
        max_pages=args.max_pages,
        concurrency=args.concurrency,
        per_host_delay=args.per_host_delay,
        request_timeout=args.timeout,
        max_retries=args.max_retries,
        user_agent=args.user_agent,
        same_subdomain=args.same_subdomain,
        respect_robots=not args.no_robots,
    )

    crawler = Crawler(config)
    pages: List[dict] = []
    broken: List[dict] = []

    async for event in crawler.crawl():
        if event.type == "page_fetched" and event.page:
            pages.append(event.page.model_dump())
            page = event.page
            if page.status_code and page.status_code >= 400:
                broken.append(
                    {
                        "url": page.url,
                        "depth": page.depth,
                        "status_code": page.status_code,
                        "parent_url": page.parent_url or "",
                        "error": page.error or "",
                    }
                )
            elif page.error:
                broken.append(
                    {
                        "url": page.url,
                        "depth": page.depth,
                        "status_code": page.status_code,
                        "parent_url": page.parent_url or "",
                        "error": page.error or "",
                    }
                )
        elif event.type.value == "error":
            print(f"[event] {event.message}", file=sys.stderr)

    # Write JSON
    result = {
        "start_url": str(config.start_url),
        "pages": pages,
        "total_pages": len(pages),
        "broken_links": broken,
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, default=str)
    print(f"Wrote {len(pages)} pages to {args.out}")

    # CSV export
    if args.csv:
        with open(args.csv, "w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(
                f,
                fieldnames=[
                    "url", "depth", "status_code", "content_type",
                    "response_time_ms", "title", "parent_url", "error",
                ],
            )
            writer.writeheader()
            for page in pages:
                writer.writerow(page)
        print(f"Wrote CSV to {args.csv}")

    # Broken links report
    if args.broken_links_report:
        with open(args.broken_links_report, "w", encoding="utf-8") as f:
            json.dump(broken, f, indent=2, default=str)
        print(f"Wrote {len(broken)} broken links to {args.broken_links_report}")


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    if args.command == "crawl":
        asyncio.run(run_crawl(args))
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
