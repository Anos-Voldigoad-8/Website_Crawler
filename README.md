# SpiderWeb

Async website crawler with a live cyberpunk visualization.

## Status

- Phase 1: async BFS crawler, robots.txt, SSRF protection, CLI.
- Phase 2: FastAPI jobs, WebSocket event streaming, JSON/CSV exports.
- Phase 3: force-directed crawl graph, IK centipede, HUD and controls.

## Run the visualization

```bash
pip install -e .
uvicorn spiderweb.api:app --reload
```

Open <http://127.0.0.1:8000>. Enter a URL and press **INITIATE CRAWL**, or use the
**DEMO** feed to watch a synthetic crawl. The interface auto-starts the demo on
first load; add `?demo=0` to open an empty scene.

Controls: drag to pan (drag a node to move it), scroll to zoom, double-click to
fit, `Space` freezes the simulation, `F` fits, `L` toggles labels and `C`
toggles the centipede.

## CLI

```bash
spiderweb crawl https://example.com --depth 3 --max-pages 200 --out result.json
```

## License

MIT
