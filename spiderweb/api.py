"""FastAPI application for SpiderWeb: crawl jobs, WebSocket streaming, exports."""

from __future__ import annotations

import asyncio
import json
from typing import Dict, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Query
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse
from pydantic import ValidationError

from .crawler import Crawler, is_blocked_ip, urlparse_host
from .models import CrawlConfig, CrawlEvent, CrawlEventType

app = FastAPI(title="SpiderWeb", version="0.1.0")


# ---------------------------------------------------------------------------
# In-memory job store
# ---------------------------------------------------------------------------

class Job:
    """A running or completed crawl job."""

    def __init__(self, job_id: str, config: CrawlConfig) -> None:
        self.job_id = job_id
        self.config = config
        self.crawler = Crawler(config)
        self._task: Optional[asyncio.Task[None]] = None
        self._status: str = "queued"  # queued | running | finished | cancelled | failed
        self._events: list[CrawlEvent] = []
        self._pages: list[dict] = []
        self._broken: list[dict] = []
        self._error: Optional[str] = None
        self._websockets: list[WebSocket] = []

    @property
    def status(self) -> str:
        return self._status

    def to_dict(self) -> dict:
        return {
            "job_id": self.job_id,
            "status": self._status,
            "start_url": str(self.config.start_url),
            "max_depth": self.config.max_depth,
            "max_pages": self.config.max_pages,
            "pages_fetched": len(self._pages),
            "broken_links": len(self._broken),
            "error": self._error,
        }


# Global job registry
_jobs: Dict[str, Job] = {}
_jobs_lock = asyncio.Lock()


async def _get_or_create_job(job_id: str) -> Optional[Job]:
    async with _jobs_lock:
        return _jobs.get(job_id)


async def _register_job(job: Job) -> None:
    async with _jobs_lock:
        _jobs[job.job_id] = job


async def _unregister_job(job_id: str) -> None:
    async with _jobs_lock:
        _jobs.pop(job_id, None)


# ---------------------------------------------------------------------------
# SSRF protection (API layer)
# ---------------------------------------------------------------------------

def _validate_start_url(url_str: str) -> Optional[str]:
    """Validate a start URL for SSRF. Returns an error message or None."""
    from .urlutils import normalize_url

    normalized = normalize_url(url_str)
    if not normalized:
        return "Invalid URL: must be a valid http(s) URL"

    host = urlparse_host(normalized)
    if host and is_blocked_ip(host):
        return f"Blocked IP address: {host}"

    return None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}


@app.post("/api/crawl")
async def start_crawl(payload: dict) -> JSONResponse:
    """Start a new crawl job.

    Body: { "url": "...", "max_depth": 3, "max_pages": 200, ... }
    Returns the job id.
    """
    url_str = payload.get("url")
    if not url_str or not isinstance(url_str, str):
        raise HTTPException(status_code=400, detail="Missing 'url' in request body")

    ssrf_error = _validate_start_url(url_str)
    if ssrf_error:
        raise HTTPException(status_code=400, detail=ssrf_error)

    try:
        config = CrawlConfig(
            start_url=url_str,
            max_depth=int(payload.get("max_depth", 3)),
            max_pages=int(payload.get("max_pages", 200)),
            concurrency=int(payload.get("concurrency", 10)),
            per_host_delay=float(payload.get("per_host_delay", 1.0)),
            request_timeout=float(payload.get("request_timeout", 30.0)),
            max_retries=int(payload.get("max_retries", 3)),
            user_agent=str(payload.get("user_agent", "SpiderWeb/1.0")),
            same_subdomain=bool(payload.get("same_subdomain", False)),
            respect_robots=bool(payload.get("respect_robots", True)),
        )
    except ValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    import uuid

    job_id = uuid.uuid4().hex
    job = Job(job_id, config)
    await _register_job(job)

    async def _run() -> None:
        job._status = "running"
        try:
            async for event in job.crawler.crawl():
                job._events.append(event)
                if event.type == CrawlEventType.PAGE_FETCHED and event.page:
                    job._pages.append(event.page.model_dump())
                    page = event.page
                    if (page.status_code and page.status_code >= 400) or page.error:
                        job._broken.append(
                            {
                                "url": page.url,
                                "depth": page.depth,
                                "status_code": page.status_code,
                                "parent_url": page.parent_url or "",
                                "error": page.error or "",
                            }
                        )
                elif event.type == CrawlEventType.ERROR:
                    job._error = event.message or "Unknown error"
                # Broadcast to WebSocket subscribers
                if job._websockets:
                    payload_text = event.model_dump_json()
                    dead: list[WebSocket] = []
                    for ws in job._websockets:
                        try:
                            await ws.send_text(payload_text)
                        except Exception:
                            dead.append(ws)
                    for ws in dead:
                        try:
                            job._websockets.remove(ws)
                        except ValueError:
                            pass
        except asyncio.CancelledError:
            job._status = "cancelled"
            raise
        except Exception as exc:  # noqa: BLE001
            job._status = "failed"
            job._error = str(exc)
        else:
            if job._status != "cancelled":
                job._status = "finished"

    job._task = asyncio.create_task(_run())
    return JSONResponse({"job_id": job_id, "status": job.status})


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str) -> JSONResponse:
    job = await _get_or_create_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return JSONResponse(job.to_dict())


@app.post("/api/jobs/{job_id}/cancel")
async def cancel_job(job_id: str) -> JSONResponse:
    job = await _get_or_create_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    job.crawler.cancel()
    if job._task and not job._task.done():
        job._task.cancel()
    job._status = "cancelled"
    return JSONResponse({"job_id": job_id, "status": "cancelled"})


@app.websocket("/ws/{job_id}")
async def ws_job(websocket: WebSocket, job_id: str) -> None:
    await websocket.accept()
    job = await _get_or_create_job(job_id)
    if not job:
        await websocket.close(code=4004)
        return

    job._websockets.append(websocket)
    try:
        # Replay historical events so a late joiner sees the crawl so far
        for event in job._events:
            await websocket.send_text(event.model_dump_json())
        # Keep connection open until the client disconnects
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        try:
            job._websockets.remove(websocket)
        except ValueError:
            pass


@app.get("/api/jobs/{job_id}/export", response_model=None)
async def export_job(
    job_id: str,
    format: str = Query(default="json", pattern="^(json|csv)$"),
) -> StreamingResponse | PlainTextResponse:
    import csv
    import io

    job = await _get_or_create_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    if format == "json":
        payload = {
            "job_id": job.job_id,
            "status": job.status,
            "start_url": str(job.config.start_url),
            "pages": job._pages,
            "total_pages": len(job._pages),
            "broken_links": job._broken,
        }
        return StreamingResponse(
            iter([json.dumps(payload, indent=2, default=str)]),
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="job_{job_id}.json"'},
        )

    # CSV
    csv_fields = [
        "url", "depth", "status_code", "content_type",
        "response_time_ms", "title", "parent_url", "error",
    ]
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=csv_fields)
    writer.writeheader()
    for page in job._pages:
        writer.writerow({k: page.get(k, "") for k in csv_fields})
    return PlainTextResponse(
        buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="job_{job_id}.csv"'},
    )


@app.on_event("shutdown")
async def _shutdown() -> None:
    """Cancel all running jobs on clean shutdown."""
    async with _jobs_lock:
        for job in list(_jobs.values()):
            if job._task and not job._task.done():
                job._task.cancel()
            job.crawler.cancel()
