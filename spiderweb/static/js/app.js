/**
 * SpiderWeb live visualization controller.
 *
 * Wires the crawler API + WebSocket stream into a force-directed graph, a
 * patrolling IK centipede, the HUD and the control deck. A synthetic demo
 * feed runs on first load so the visualization is alive before a real crawl.
 */

import { Centipede } from "./creature.js";
import { ForceGraph } from "./graph.js";

const $ = (selector) => document.querySelector(selector);

const canvas = $("#scene");
const feed = $("#event-feed");
const feedCount = $("#feed-count");
const emptyState = $("#empty-state");
const toastEl = $("#toast");
const inspector = $("#inspector");

const ui = {
  statusPill: $("#status-pill"),
  statusText: $("#status-text"),
  clock: $("#clock"),
  jobId: $("#job-id"),
  modeTag: $("#mode-tag"),
  pages: $("#stat-pages"),
  links: $("#stat-links"),
  depth: $("#stat-depth"),
  broken: $("#stat-broken"),
  form: $("#crawl-form"),
  url: $("#url-input"),
  maxDepth: $("#depth-input"),
  maxPages: $("#pages-input"),
  start: $("#start-btn"),
  cancel: $("#cancel-btn"),
  pause: $("#pause-btn"),
  labels: $("#labels-btn"),
  creature: $("#creature-btn"),
  fit: $("#fit-btn"),
  reset: $("#reset-btn"),
  demo: $("#demo-btn"),
  exportJson: $("#export-json"),
  exportCsv: $("#export-csv"),
  inspectorTitle: $("#inspector-title"),
  inspectorUrl: $("#inspector-url"),
  inspectorState: $("#inspector-state"),
  inspectorDepth: $("#inspector-depth"),
  inspectorTime: $("#inspector-time"),
  inspectorParent: $("#inspector-parent"),
  inspectorOutgoing: $("#inspector-outgoing"),
  inspectorClose: $("#inspector-close"),
  inspectorFocus: $("#inspector-focus"),
};

const graph = new ForceGraph(canvas, {
  onSelect: (node) => {
    if (node) showInspector(node);
    else hideInspector();
  },
});

const creature = new Centipede({
  segments: 19,
  segmentSpacing: 17,
  bodyWidth: 15,
  maxSpeed: 98,
  legReach: 37,
});

const state = {
  jobId: null,
  ws: null,
  pingTimer: 0,
  pollTimer: 0,
  demo: false,
  demoTimers: [],
  status: "idle",
  startedAt: 0,
  finishedAt: 0,
  discovered: new Set(),
  fetched: new Set(),
  links: new Set(),
  broken: 0,
  errors: 0,
  maxDepth: 0,
  eventCount: 0,
  lastClockText: "",
  paused: false,
  labels: true,
  creatureVisible: true,
};

let nextRetarget = 0;
let toastTimer = 0;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function prettyUrl(url) {
  try {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`;
    return path === "/" ? parsed.hostname : path;
  } catch {
    return url;
  }
}

function formatDuration(milliseconds) {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function clockTime() {
  const now = new Date();
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function titleize(value) {
  return value
    .replace(/[-_/]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

function setStatus(kind, text) {
  ui.statusPill.className = `status-pill status-${kind}`;
  ui.statusText.textContent = text;
}

function setMode(text, kind = "idle") {
  ui.modeTag.textContent = text;
  ui.modeTag.className = `mode-tag mode-${kind}`;
}

function updateStats() {
  ui.pages.textContent = state.fetched.size;
  ui.links.textContent = state.links.size;
  ui.depth.textContent = state.maxDepth;
  ui.broken.textContent = state.broken;
  feedCount.textContent = state.eventCount;
  emptyState.classList.toggle("visible", graph.nodes.size === 0);
  if (graph.selected) showInspector(graph.selected);
}

function updateClock(now = performance.now()) {
  const text = state.startedAt
    ? formatDuration((state.finishedAt || now) - state.startedAt)
    : "00:00";
  if (text !== state.lastClockText) {
    state.lastClockText = text;
    ui.clock.textContent = text;
  }
}

function toast(message, kind = "info") {
  toastEl.textContent = message;
  toastEl.className = `toast show toast-${kind}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.className = "toast";
  }, 2800);
}

function logEvent(kind, text, url = null) {
  state.eventCount += 1;

  const item = document.createElement("li");
  item.className = `feed-item feed-${kind}`;

  const time = document.createElement("span");
  time.className = "feed-time";
  time.textContent = clockTime();

  const tag = document.createElement("span");
  tag.className = "feed-tag";
  tag.textContent =
    {
      discover: "DISC",
      fetch: "GET",
      error: "ERR",
      done: "DONE",
      system: "SYS",
      link: "LINK",
    }[kind] || "SYS";

  const message = document.createElement("span");
  message.className = "feed-text";
  message.textContent = text;

  item.append(time, tag, message);

  if (url && graph.nodes.has(url)) {
    item.classList.add("clickable");
    item.title = url;
    item.addEventListener("click", () => {
      const node = graph.nodes.get(url);
      if (!node) return;
      graph.select(node);
      graph.focus(url, Math.max(graph.camera.zoom, 1.05));
    });
  }

  feed.prepend(item);
  while (feed.children.length > 48) feed.lastElementChild.remove();
  feedCount.textContent = state.eventCount;
}

function showInspector(node) {
  if (!node) {
    hideInspector();
    return;
  }

  ui.inspectorTitle.textContent = node.title || prettyUrl(node.url);
  ui.inspectorUrl.textContent = node.url;
  ui.inspectorUrl.title = node.url;

  let stateLabel = "DISCOVERED";
  let stateClass = "state-discovered";
  if (node.state === "ok") {
    stateLabel = `${node.statusCode ?? 200} OK`;
    stateClass = "state-ok";
  } else if (node.state === "error") {
    stateLabel = node.statusCode ? `${node.statusCode} ERROR` : "ERROR";
    stateClass = "state-error";
  } else if (node.state === "fetching") {
    stateLabel = "FETCHING";
    stateClass = "state-fetching";
  }

  ui.inspectorState.textContent = stateLabel;
  ui.inspectorState.className = `inspector-state ${stateClass}`;
  ui.inspectorDepth.textContent = node.depth ?? 0;
  ui.inspectorTime.textContent =
    node.responseTime > 0 ? `${Math.round(node.responseTime)} ms` : "—";
  ui.inspectorParent.textContent = node.parent ? prettyUrl(node.parent) : "—";
  ui.inspectorParent.title = node.parent || "";
  ui.inspectorOutgoing.textContent = node.outgoing ?? 0;
  inspector.classList.add("visible");
}

function hideInspector() {
  inspector.classList.remove("visible");
}

function setExportsEnabled(enabled) {
  for (const link of [ui.exportJson, ui.exportCsv]) {
    if (enabled && state.jobId) {
      link.classList.remove("disabled");
      link.removeAttribute("aria-disabled");
      link.href = `/api/jobs/${state.jobId}/export?format=${link.dataset.format}`;
    } else {
      link.classList.add("disabled");
      link.setAttribute("aria-disabled", "true");
      link.removeAttribute("href");
    }
  }
}

function setCancelEnabled(enabled) {
  ui.cancel.disabled = !enabled;
}

// ---------------------------------------------------------------------------
// Event stream
// ---------------------------------------------------------------------------

function handleEvent(event) {
  if (!event || !event.type) return;
  const type = event.type;

  if (type === "page_discovered") {
    const page = event.page || {};
    if (!page.url) return;
    const isNew = !state.discovered.has(page.url);
    if (isNew) {
      state.discovered.add(page.url);
      state.maxDepth = Math.max(state.maxDepth, page.depth ?? 0);
      graph.addNode(page.url, {
        depth: page.depth ?? 0,
        parent: page.parent_url,
        title: page.title,
      });
      logEvent(
        "discover",
        `D${page.depth ?? 0} · ${prettyUrl(page.url)}`,
        page.url,
      );
    } else {
      graph.addNode(page.url, {
        depth: page.depth ?? 0,
        parent: page.parent_url,
        title: page.title,
      });
    }
  } else if (type === "link_found") {
    if (!event.parent_url || !event.link) return;
    const key = `${event.parent_url}\u0000${event.link}`;
    if (state.links.has(key)) return;
    state.links.add(key);
    graph.addLink(event.parent_url, event.link);
  } else if (type === "page_fetched") {
    const page = event.page;
    if (!page || !page.url) return;

    const isNew = !state.fetched.has(page.url);
    if (isNew) state.fetched.add(page.url);

    const broken = Boolean(page.error) || (page.status_code ?? 0) >= 400;
    if (isNew && broken) state.broken += 1;

    const node = graph.applyPage(page);
    if (node && Math.random() < 0.4) {
      creature.setTarget(node.x, node.y);
      nextRetarget = performance.now() + 2300;
    }

    const status = page.error ? "ERR" : page.status_code ?? "—";
    const title = page.title ? ` — ${page.title}` : "";
    logEvent(
      broken ? "error" : "fetch",
      `${status} · ${prettyUrl(page.url)}${title}`,
      page.url,
    );
  } else if (type === "error") {
    state.errors += 1;
    logEvent("error", event.message || "Unknown crawler error", event.parent_url || null);
  } else if (type === "finished") {
    state.finishedAt = performance.now();
    state.status = "complete";
    setStatus("complete", "COMPLETE");
    setCancelEnabled(false);
    setExportsEnabled(true);
    logEvent("done", `Crawl finished · ${state.fetched.size} pages`);
    disconnectSocket();
  }

  updateStats();
  updateClock();
}

// ---------------------------------------------------------------------------
// API + WebSocket
// ---------------------------------------------------------------------------

function disconnectSocket() {
  if (state.pingTimer) {
    clearInterval(state.pingTimer);
    state.pingTimer = 0;
  }
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = 0;
  }
  if (state.ws) {
    const socket = state.ws;
    state.ws = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  }
}

function connectSocket(jobId) {
  disconnectSocket();
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws/${jobId}`);
  state.ws = socket;

  socket.onopen = () => {
    logEvent("system", "Live telemetry uplink established");
    state.pingTimer = window.setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send("ping");
    }, 20000);
  };

  socket.onmessage = (message) => {
    try {
      handleEvent(JSON.parse(message.data));
    } catch {
      /* ignore malformed frames */
    }
  };

  socket.onerror = () => {
    logEvent("error", "Telemetry uplink error");
  };

  socket.onclose = () => {
    if (state.ws === socket) state.ws = null;
    if (state.status === "running") {
      logEvent("system", "Uplink closed · polling job status");
      startPolling(jobId);
    }
  };
}

function startPolling(jobId) {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = window.setInterval(async () => {
    try {
      const response = await fetch(`/api/jobs/${jobId}`);
      if (!response.ok) throw new Error("Job lookup failed");
      const job = await response.json();
      if (job.status === "finished") {
        clearInterval(state.pollTimer);
        state.pollTimer = 0;
        state.finishedAt = performance.now();
        state.status = "complete";
        setStatus("complete", "COMPLETE");
        setCancelEnabled(false);
        setExportsEnabled(true);
        logEvent("done", `Crawl finished · ${state.fetched.size} pages`);
        updateStats();
      } else if (job.status === "failed" || job.status === "cancelled") {
        clearInterval(state.pollTimer);
        state.pollTimer = 0;
        state.finishedAt = performance.now();
        state.status = job.status;
        setStatus(job.status === "failed" ? "error" : "cancelled", job.status.toUpperCase());
        setCancelEnabled(false);
        if (job.error) logEvent("error", job.error);
        updateStats();
      }
    } catch {
      /* keep polling through transient errors */
    }
  }, 1800);
}

function resetRun() {
  stopDemo();
  disconnectSocket();

  state.jobId = null;
  state.status = "idle";
  state.startedAt = 0;
  state.finishedAt = 0;
  state.discovered.clear();
  state.fetched.clear();
  state.links.clear();
  state.broken = 0;
  state.errors = 0;
  state.maxDepth = 0;
  state.eventCount = 0;
  state.lastClockText = "";
  state.demo = false;
  nextRetarget = 0;

  graph.clear();
  graph.setPaused(state.paused);
  creature.spawn(0, 0, Math.random() * Math.PI * 2);
  feed.replaceChildren();
  feedCount.textContent = "0";
  ui.jobId.textContent = "—";
  ui.clock.textContent = "00:00";
  ui.start.disabled = false;
  setStatus("idle", "STANDBY");
  setMode("IDLE");
  setCancelEnabled(false);
  setExportsEnabled(false);
  hideInspector();
  updateStats();
  updateClock();
}

async function startCrawl(url) {
  const previousJob = state.jobId;
  stopDemo();
  if (previousJob) {
    fetch(`/api/jobs/${previousJob}/cancel`, { method: "POST" }).catch(() => {});
  }
  disconnectSocket();
  resetRun();

  state.status = "running";
  state.startedAt = performance.now();
  setStatus("running", "CRAWLING");
  setMode("LIVE", "live");
  setCancelEnabled(true);
  ui.start.disabled = true;
  logEvent("system", `Target acquired · ${url}`);

  try {
    const response = await fetch("/api/crawl", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        max_depth: Number(ui.maxDepth.value) || 3,
        max_pages: Number(ui.maxPages.value) || 200,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.detail || `Request failed (${response.status})`);
    }

    state.jobId = payload.job_id;
    ui.jobId.textContent = payload.job_id.slice(0, 12);
    setExportsEnabled(true);
    connectSocket(payload.job_id);
    updateStats();
  } catch (error) {
    state.status = "error";
    state.finishedAt = performance.now();
    setStatus("error", "FAILED");
    setCancelEnabled(false);
    setExportsEnabled(false);
    logEvent("error", error.message || "Could not start crawl");
    toast(error.message || "Could not start crawl", "error");
  } finally {
    ui.start.disabled = false;
  }
}

async function cancelCrawl() {
  if (state.demo) {
    stopDemo();
    state.status = "cancelled";
    state.finishedAt = performance.now();
    setStatus("cancelled", "STOPPED");
    setCancelEnabled(false);
    logEvent("system", "Simulation halted");
    updateStats();
    return;
  }

  if (!state.jobId) return;
  try {
    await fetch(`/api/jobs/${state.jobId}/cancel`, { method: "POST" });
    state.status = "cancelled";
    state.finishedAt = performance.now();
    setStatus("cancelled", "ABORTED");
    setCancelEnabled(false);
    logEvent("system", "Crawl aborted by operator");
    disconnectSocket();
    updateStats();
  } catch {
    toast("Could not cancel the crawl", "error");
  }
}

// ---------------------------------------------------------------------------
// Synthetic demo feed
// ---------------------------------------------------------------------------

function stopDemo() {
  state.demo = false;
  for (const timer of state.demoTimers) clearTimeout(timer);
  state.demoTimers = [];
}

function buildDemoPages() {
  const root = "https://neon.example/";
  const sections = [
    { path: "docs", title: "Documentation", children: ["quickstart", "api", "guides", "faq", "changelog"] },
    { path: "blog", title: "Blog", children: ["neon-nights", "ik-tentacles", "force-layouts", "year-in-review"] },
    { path: "lab", title: "Laboratory", children: ["centipede", "graph-engine", "scanner"] },
    { path: "shop", title: "Shop", children: ["kits", "parts", "shipping"] },
    { path: "about", title: "About", children: ["team", "contact", "press"] },
  ];

  const pages = [
    { url: root, depth: 0, parent: null, title: "Neon Labs // Home", children: [] },
  ];
  const byUrl = new Map([[root, pages[0]]]);

  for (const section of sections) {
    const sectionUrl = `${root}${section.path}`;
    const sectionPage = {
      url: sectionUrl,
      depth: 1,
      parent: root,
      title: section.title,
      children: [],
    };
    pages.push(sectionPage);
    byUrl.set(sectionUrl, sectionPage);
    pages[0].children.push(sectionUrl);

    for (const child of section.children) {
      const childUrl = `${sectionUrl}/${child}`;
      const childPage = {
        url: childUrl,
        depth: 2,
        parent: sectionUrl,
        title: titleize(child),
        children: [],
      };
      pages.push(childPage);
      byUrl.set(childUrl, childPage);
      sectionPage.children.push(childUrl);
    }
  }

  // A third level under the docs section.
  const quickstart = byUrl.get(`${root}docs/quickstart`);
  if (quickstart) {
    for (const leaf of ["install", "first-crawl"]) {
      const leafUrl = `${quickstart.url}/${leaf}`;
      const leafPage = {
        url: leafUrl,
        depth: 3,
        parent: quickstart.url,
        title: titleize(leaf),
        children: [],
      };
      pages.push(leafPage);
      byUrl.set(leafUrl, leafPage);
      quickstart.children.push(leafUrl);
    }
  }

  return pages;
}

function runDemo() {
  stopDemo();
  disconnectSocket();
  resetRun();

  state.demo = true;
  state.status = "running";
  state.startedAt = performance.now();
  setStatus("demo", "SIMULATING");
  setMode("DEMO", "demo");
  setCancelEnabled(true);
  logEvent("system", "Synthetic crawl engaged · neon.example");

  const pages = buildDemoPages();
  const broken = new Set(["/docs/changelog", "/about/press", "/shop/parts"]);
  const errored = new Set(["/blog/year-in-review"]);
  let cursor = 260;

  const schedule = (delay, event) => {
    const timer = window.setTimeout(() => {
      if (!state.demo) return;
      handleEvent(event);
    }, delay);
    state.demoTimers.push(timer);
  };

  schedule(0, {
    type: "page_discovered",
    page: { url: pages[0].url, depth: 0, parent_url: null, title: pages[0].title },
  });
  schedule(240, {
    type: "page_fetched",
    page: {
      url: pages[0].url,
      depth: 0,
      parent_url: null,
      title: pages[0].title,
      status_code: 200,
      content_type: "text/html",
      response_time_ms: 184,
      outgoing_links: pages[0].children,
    },
  });
  for (const child of pages[0].children) {
    schedule(260, {
      type: "link_found",
      parent_url: pages[0].url,
      link: child,
    });
  }

  for (const page of pages.slice(1)) {
    cursor += 105 + Math.random() * 165;
    const discoveredAt = cursor;

    schedule(discoveredAt, {
      type: "page_discovered",
      page: {
        url: page.url,
        depth: page.depth,
        parent_url: page.parent,
        title: page.title,
      },
    });

    for (const child of page.children) {
      schedule(discoveredAt + 18, {
        type: "link_found",
        parent_url: page.url,
        link: child,
      });
    }

    const isBroken = [...broken].some((suffix) => page.url.endsWith(suffix));
    const isErrored = [...errored].some((suffix) => page.url.endsWith(suffix));
    const fetchedAt = discoveredAt + 210 + Math.random() * 260;

    schedule(fetchedAt, {
      type: "page_fetched",
      page: {
        url: page.url,
        depth: page.depth,
        parent_url: page.parent,
        title: isBroken ? "Not Found" : page.title,
        status_code: isErrored ? null : isBroken ? 404 : 200,
        content_type: isErrored ? "" : "text/html",
        response_time_ms: isErrored ? 30000 : Math.round(70 + Math.random() * 420),
        outgoing_links: page.children,
        error: isErrored ? "Request timed out after 30.0s" : null,
      },
    });
  }

  schedule(cursor + 1000, { type: "finished" });
}

// ---------------------------------------------------------------------------
// Creature patrol
// ---------------------------------------------------------------------------

function updateCreature(dt) {
  const now = performance.now();
  if (now > nextRetarget) {
    const nodes = Array.from(graph.nodes.values());
    if (nodes.length > 0) {
      const fresh = nodes.filter((node) => graph.time - node.lastActive < 3.5);
      const pool = fresh.length > 0 && Math.random() < 0.58 ? fresh : nodes;
      const node = pool[Math.floor(Math.random() * pool.length)];
      creature.setTarget(
        node.x + (Math.random() - 0.5) * 70,
        node.y + (Math.random() - 0.5) * 70,
      );
    } else {
      const bounds = graph.getBounds(0);
      creature.setTarget(
        bounds.minX + Math.random() * (bounds.maxX - bounds.minX),
        bounds.minY + Math.random() * (bounds.maxY - bounds.minY),
      );
    }
    nextRetarget = now + 2800 + Math.random() * 3400;
  }

  const bounds = graph.getBounds(170);
  creature.setBounds(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY);
  creature.update(dt);
}

// ---------------------------------------------------------------------------
// Canvas backdrop + render loop
// ---------------------------------------------------------------------------

const stars = Array.from({ length: 80 }, () => ({
  x: Math.random(),
  y: Math.random(),
  radius: 0.4 + Math.random() * 1.4,
  alpha: 0.12 + Math.random() * 0.35,
  drift: 0.004 + Math.random() * 0.012,
}));

function drawBackdrop(ctx, dt) {
  const width = graph.width;
  const height = graph.height;
  const dpr = graph.dpr;
  const zoom = graph.camera.zoom;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#04070d";
  ctx.fillRect(0, 0, width, height);

  const glow = ctx.createRadialGradient(
    width * 0.62,
    height * 0.34,
    0,
    width * 0.62,
    height * 0.34,
    Math.max(width, height) * 0.75,
  );
  glow.addColorStop(0, "rgba(15, 82, 102, 0.24)");
  glow.addColorStop(0.42, "rgba(9, 38, 58, 0.12)");
  glow.addColorStop(1, "rgba(2, 4, 9, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  const minor = 64 * zoom;
  if (minor > 9) {
    const startWorldX = Math.floor(-graph.camera.x / zoom / 64) * 64;
    const startWorldY = Math.floor(-graph.camera.y / zoom / 64) * 64;
    const endX = (width - graph.camera.x) / zoom;
    const endY = (height - graph.camera.y) / zoom;

    for (let worldX = startWorldX; worldX <= endX; worldX += 64) {
      const screenX = worldX * zoom + graph.camera.x;
      const major = Math.round(worldX / 64) % 5 === 0;
      ctx.beginPath();
      ctx.moveTo(screenX, 0);
      ctx.lineTo(screenX, height);
      ctx.strokeStyle = major ? "rgba(60, 180, 210, 0.075)" : "rgba(60, 180, 210, 0.032)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    for (let worldY = startWorldY; worldY <= endY; worldY += 64) {
      const screenY = worldY * zoom + graph.camera.y;
      const major = Math.round(worldY / 64) % 5 === 0;
      ctx.beginPath();
      ctx.moveTo(0, screenY);
      ctx.lineTo(width, screenY);
      ctx.strokeStyle = major ? "rgba(60, 180, 210, 0.075)" : "rgba(60, 180, 210, 0.032)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  for (const star of stars) {
    star.y -= star.drift * dt * 60;
    if (star.y < -0.02) star.y = 1.02;
    ctx.beginPath();
    ctx.arc(star.x * width, star.y * height, star.radius, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(120, 225, 245, ${star.alpha})`;
    ctx.fill();
  }

  // Vignette.
  const vignette = ctx.createRadialGradient(
    width / 2,
    height / 2,
    Math.min(width, height) * 0.32,
    width / 2,
    height / 2,
    Math.max(width, height) * 0.78,
  );
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.56)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);
}

let lastFrame = performance.now();

function frame(now) {
  const dt = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;

  graph.step(dt);
  updateCreature(dt);

  const ctx = graph.ctx;
  drawBackdrop(ctx, dt);

  ctx.save();
  graph.applyCamera(ctx);
  graph.drawWorld(ctx);
  creature.draw(ctx);
  graph.drawLabels(ctx);
  ctx.restore();

  updateClock(now);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

const pointer = {
  down: false,
  node: null,
  startX: 0,
  startY: 0,
  lastX: 0,
  lastY: 0,
  moved: false,
};

function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

canvas.addEventListener("pointerdown", (event) => {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  const point = canvasPoint(event);
  const node = graph.pick(point.x, point.y);

  pointer.down = true;
  pointer.node = node;
  pointer.startX = point.x;
  pointer.startY = point.y;
  pointer.lastX = point.x;
  pointer.lastY = point.y;
  pointer.moved = false;

  if (node) {
    graph.beginDrag(node);
    graph.select(node);
  } else {
    canvas.style.cursor = "grabbing";
  }
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener("pointermove", (event) => {
  const point = canvasPoint(event);

  if (pointer.down) {
    const moved = Math.hypot(point.x - pointer.startX, point.y - pointer.startY);
    if (moved > 3) pointer.moved = true;

    if (pointer.node) {
      graph.dragTo(point.x, point.y);
    } else {
      graph.panBy(point.x - pointer.lastX, point.y - pointer.lastY);
    }
    pointer.lastX = point.x;
    pointer.lastY = point.y;
    return;
  }

  graph.setHovered(graph.pick(point.x, point.y));
});

function endPointer(event) {
  if (!pointer.down) return;
  if (pointer.node) {
    graph.endDrag();
  } else if (!pointer.moved) {
    graph.select(null);
  }
  pointer.down = false;
  pointer.node = null;
  canvas.style.cursor = graph.hovered ? "pointer" : "grab";
  if (event && event.pointerId !== undefined && canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
}

canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);

canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const point = canvasPoint(event);
    const factor = Math.exp(-event.deltaY * 0.0013);
    graph.zoomAt(point.x, point.y, factor);
  },
  { passive: false },
);

canvas.addEventListener("dblclick", (event) => {
  const point = canvasPoint(event);
  if (!graph.pick(point.x, point.y)) graph.fit(110);
});

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

ui.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const url = ui.url.value.trim();
  if (!url) {
    toast("Enter a target URL first", "error");
    ui.url.focus();
    return;
  }
  startCrawl(url);
});

ui.cancel.addEventListener("click", cancelCrawl);

ui.pause.addEventListener("click", () => {
  state.paused = !state.paused;
  graph.setPaused(state.paused);
  creature.paused = state.paused;
  ui.pause.classList.toggle("active", state.paused);
  ui.pause.setAttribute("aria-pressed", String(state.paused));
  ui.pause.querySelector(".control-label").textContent = state.paused ? "RESUME" : "PAUSE";
  toast(state.paused ? "Simulation frozen" : "Simulation resumed");
});

ui.labels.addEventListener("click", () => {
  state.labels = !state.labels;
  graph.setLabels(state.labels);
  ui.labels.classList.toggle("active", state.labels);
  ui.labels.setAttribute("aria-pressed", String(state.labels));
});

ui.creature.addEventListener("click", () => {
  state.creatureVisible = !state.creatureVisible;
  creature.visible = state.creatureVisible;
  ui.creature.classList.toggle("active", state.creatureVisible);
  ui.creature.setAttribute("aria-pressed", String(state.creatureVisible));
});

ui.fit.addEventListener("click", () => {
  graph.fit(110);
  toast("View fitted to graph");
});

ui.reset.addEventListener("click", () => {
  resetRun();
  toast("Scene reset");
});

ui.demo.addEventListener("click", () => {
  runDemo();
  toast("Synthetic crawl engaged", "info");
});

ui.inspectorClose.addEventListener("click", () => graph.select(null));
ui.inspectorFocus.addEventListener("click", () => {
  if (graph.selected) graph.focus(graph.selected.id, Math.max(1.15, graph.camera.zoom));
});

ui.exportJson.addEventListener("click", (event) => {
  if (ui.exportJson.classList.contains("disabled")) event.preventDefault();
});
ui.exportCsv.addEventListener("click", (event) => {
  if (ui.exportCsv.classList.contains("disabled")) event.preventDefault();
});

window.addEventListener("keydown", (event) => {
  const tag = event.target?.tagName;
  if (["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(tag)) return;

  if (event.code === "Space") {
    event.preventDefault();
    ui.pause.click();
  } else if (event.key === "f" || event.key === "F") {
    graph.fit(110);
  } else if (event.key === "l" || event.key === "L") {
    ui.labels.click();
  } else if (event.key === "c" || event.key === "C") {
    ui.creature.click();
  } else if (event.key === "r" || event.key === "R") {
    graph.fit(110);
  } else if (event.key === "Escape") {
    graph.select(null);
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  graph.resize(window.innerWidth, window.innerHeight, dpr);
}

window.addEventListener("resize", resize);
resize();

const params = new URLSearchParams(location.search);
if (params.get("url")) ui.url.value = params.get("url");

resetRun();
requestAnimationFrame(frame);

if (params.get("demo") !== "0") {
  window.setTimeout(() => {
    if (state.status === "idle" && graph.nodes.size === 0) runDemo();
  }, 850);
}
