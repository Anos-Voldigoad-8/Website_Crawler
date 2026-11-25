"""Tests for the Phase 3 visualization assets and routes."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from spiderweb.api import app

STATIC_DIR = Path(__file__).resolve().parents[1] / "spiderweb" / "static"


def test_index_served() -> None:
    client = TestClient(app)
    response = client.get("/")
    assert response.status_code == 200
    assert "SPIDER" in response.text
    assert "/static/js/app.js" in response.text
    assert "/static/css/style.css" in response.text


def test_static_assets_served() -> None:
    client = TestClient(app)
    assets = [
        "/static/css/style.css",
        "/static/js/app.js",
        "/static/js/creature.js",
        "/static/js/graph.js",
        "/static/js/ik.js",
    ]
    for asset in assets:
        response = client.get(asset)
        assert response.status_code == 200, asset
        assert response.text.strip(), asset


def test_visualization_modules_exist() -> None:
    assert (STATIC_DIR / "index.html").is_file()
    assert (STATIC_DIR / "css" / "style.css").is_file()
    for module in ("app.js", "creature.js", "graph.js", "ik.js"):
        path = STATIC_DIR / "js" / module
        assert path.is_file()
        assert path.stat().st_size > 0


def test_ik_module_exports_solver() -> None:
    source = (STATIC_DIR / "js" / "ik.js").read_text(encoding="utf-8")
    assert "export function solveFABRIK" in source
    assert "export function solveTwoBone" in source
