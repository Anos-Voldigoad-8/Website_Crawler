"""Data models for the SpiderWeb crawler."""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, List, Optional
from uuid import uuid4

from pydantic import BaseModel, Field, HttpUrl


class CrawlEventType(str, Enum):
    """Types of events yielded by the crawl generator."""

    PAGE_DISCOVERED = "page_discovered"
    PAGE_FETCHED = "page_fetched"
    LINK_FOUND = "link_found"
    ERROR = "error"
    FINISHED = "finished"


class CrawlConfig(BaseModel):
    """Configuration for a crawl job."""

    start_url: HttpUrl
    max_depth: int = 3
    max_pages: int = 200
    concurrency: int = 10
    per_host_delay: float = 1.0
    request_timeout: float = 30.0
    max_retries: int = 3
    backoff_factor: float = 0.5
    user_agent: str = "SpiderWeb/1.0 (+https://github.com/Anos-Voldigoad-8/Website_Crawler)"
    same_subdomain: bool = False
    respect_robots: bool = True


class PageRecord(BaseModel):
    """Record of a single crawled page."""

    url: str
    depth: int
    status_code: Optional[int] = None
    content_type: Optional[str] = None
    response_time_ms: float = 0.0
    title: Optional[str] = None
    outgoing_links: List[str] = Field(default_factory=list)
    parent_url: Optional[str] = None
    error: Optional[str] = None
    fetched_at: Optional[datetime] = None


class CrawlEvent(BaseModel):
    """Event yielded by the crawl generator."""

    type: CrawlEventType
    job_id: str = Field(default_factory=lambda: uuid4().hex)
    page: Optional[PageRecord] = None
    link: Optional[str] = None
    parent_url: Optional[str] = None
    message: Optional[str] = None
    timestamp: datetime = Field(default_factory=datetime.utcnow)

    class Config:
        """Pydantic config."""

        use_enum_values = True
