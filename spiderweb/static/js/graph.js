/**
 * ForceGraph: a dependency-free force-directed graph for crawl results.
 *
 * Nodes are pages, links are discovered hyperlinks. The simulation uses a
 * spatial hash for repulsion, spring forces for links, and a gentle gravity
 * well so disconnected fragments stay on screen. Rendering is done in world
 * space under a pan/zoom camera.
 */

import { TAU, clamp, lerp } from "./ik.js";

const STATE = {
  discovered: { color: "#3f8fa3", rgb: [63, 143, 163] },
  fetching: { color: "#ffc857", rgb: [255, 200, 87] },
  ok: { color: "#4df3ff", rgb: [77, 243, 255] },
  error: { color: "#ff3b6b", rgb: [255, 59, 107] },
};

const ROOT = { color: "#ff4fb8", rgb: [255, 79, 184] };

const rgba = (rgb, alpha) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function labelFor(url) {
  try {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname || "/");
    return path === "/" ? parsed.hostname : path;
  } catch {
    return url;
  }
}

function truncate(value, length) {
  if (!value) return "";
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

export class ForceGraph {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.nodes = new Map();
    this.links = new Map();
    this.camera = { x: 0, y: 0, zoom: 1 };
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.time = 0;
    this.temperature = 0.2;
    this.paused = false;
    this.showLabels = options.showLabels ?? true;
    this.hovered = null;
    this.selected = null;
    this.onSelect = options.onSelect ?? null;
    this._dragged = null;
  }

  resize(width, height, dpr = 1) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.dpr = dpr;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
  }

  clear() {
    this.nodes.clear();
    this.links.clear();
    this.hovered = null;
    this.selected = null;
    this.temperature = 0.2;
    this.camera = { x: this.width / 2, y: this.height / 2, zoom: 1 };
    if (this.onSelect) this.onSelect(null);
  }

  addNode(url, options = {}) {
    if (!url) return null;
    const existing = this.nodes.get(url);
    if (existing) {
      if (options.parent && options.parent !== url) {
        this.addLink(options.parent, url);
      }
      return existing;
    }

    const { depth = 0, parent = null, title = null } = options;
    const parentNode = parent ? this.nodes.get(parent) : null;
    const seed = hashString(url);
    const angle = (seed % 360) * (Math.PI / 180);
    const ring = parentNode ? 68 + (seed % 44) : 100 + (seed % 160);
    const x = parentNode ? parentNode.x + Math.cos(angle) * ring : Math.cos(angle) * ring;
    const y = parentNode ? parentNode.y + Math.sin(angle) * ring : Math.sin(angle) * ring;
    const isRoot = this.nodes.size === 0 && !parent;

    const node = {
      id: url,
      url,
      label: title || labelFor(url),
      title,
      parent,
      x,
      y,
      vx: 0,
      vy: 0,
      depth,
      radius: isRoot ? 13 : 6.5 + Math.min(depth, 5) * 1.25,
      state: "discovered",
      isRoot,
      statusCode: null,
      responseTime: 0,
      contentType: "",
      outgoing: 0,
      error: null,
      appear: 0,
      pulse: 0,
      lastActive: this.time,
      dragging: false,
      seed: (seed % 1000) / 1000,
    };

    this.nodes.set(url, node);
    if (parent && parent !== url) this.addLink(parent, url);
    this.temperature = 1;
    return node;
  }

  addLink(sourceUrl, targetUrl) {
    if (!sourceUrl || !targetUrl || sourceUrl === targetUrl) return null;
    const source = this.nodes.get(sourceUrl);
    const target = this.nodes.get(targetUrl);
    if (!source || !target) return null;

    const key = `${sourceUrl}\u0000${targetUrl}`;
    const existing = this.links.get(key);
    if (existing) return existing;

    const link = {
      key,
      source: sourceUrl,
      target: targetUrl,
      phase: (hashString(key) % 1000) / 1000,
      lastActive: this.time,
    };
    this.links.set(key, link);
    this.temperature = Math.max(this.temperature, 0.55);
    return link;
  }

  markFetching(url) {
    const node = this.nodes.get(url);
    if (!node || node.state === "error") return;
    node.state = "fetching";
    node.pulse = 1;
    node.lastActive = this.time;
    this.temperature = Math.max(this.temperature, 0.35);
  }

  applyPage(page) {
    if (!page || !page.url) return null;
    let node = this.nodes.get(page.url);
    if (!node) {
      node = this.addNode(page.url, {
        depth: page.depth ?? 0,
        parent: page.parent_url,
        title: page.title,
      });
    }
    if (!node) return null;

    node.depth = page.depth ?? node.depth;
    node.parent = page.parent_url ?? node.parent;
    node.title = page.title || node.title;
    node.label = page.title || labelFor(page.url);
    node.statusCode = page.status_code ?? null;
    node.responseTime = page.response_time_ms ?? 0;
    node.contentType = page.content_type ?? "";
    node.outgoing = Array.isArray(page.outgoing_links) ? page.outgoing_links.length : 0;
    node.error = page.error ?? null;
    node.state = page.error || (page.status_code && page.status_code >= 400) ? "error" : "ok";
    node.radius = node.isRoot
      ? 13
      : 6.5 + Math.min(node.depth, 5) * 1.25 + (node.state === "ok" ? 0.8 : 0);
    node.pulse = 1;
    node.lastActive = this.time;

    if (page.parent_url) this.addLink(page.parent_url, page.url);
    this.temperature = Math.max(this.temperature, 0.55);
    return node;
  }

  markError(url) {
    const node = this.nodes.get(url);
    if (!node) return;
    node.state = "error";
    node.pulse = 1;
    node.lastActive = this.time;
  }

  select(nodeOrUrl) {
    let node = nodeOrUrl;
    if (typeof nodeOrUrl === "string") node = this.nodes.get(nodeOrUrl) || null;
    this.selected = node || null;
    if (this.onSelect) this.onSelect(this.selected);
  }

  setHovered(nodeOrUrl) {
    let node = nodeOrUrl;
    if (typeof nodeOrUrl === "string") node = this.nodes.get(nodeOrUrl) || null;
    this.hovered = node || null;
    this.canvas.style.cursor = node ? "pointer" : "grab";
  }

  setPaused(paused) {
    this.paused = Boolean(paused);
  }

  setLabels(show) {
    this.showLabels = Boolean(show);
  }

  beginDrag(node) {
    if (!node) return;
    this._dragged = node;
    node.dragging = true;
    node.vx = 0;
    node.vy = 0;
  }

  dragTo(screenX, screenY) {
    if (!this._dragged) return;
    const point = this.screenToWorld(screenX, screenY);
    this._dragged.x = point.x;
    this._dragged.y = point.y;
    this._dragged.vx = 0;
    this._dragged.vy = 0;
    this.temperature = Math.max(this.temperature, 0.4);
  }

  endDrag() {
    if (this._dragged) this._dragged.dragging = false;
    this._dragged = null;
  }

  worldToScreen(point) {
    return {
      x: point.x * this.camera.zoom + this.camera.x,
      y: point.y * this.camera.zoom + this.camera.y,
    };
  }

  screenToWorld(screenX, screenY) {
    return {
      x: (screenX - this.camera.x) / this.camera.zoom,
      y: (screenY - this.camera.y) / this.camera.zoom,
    };
  }

  panBy(dx, dy) {
    this.camera.x += dx;
    this.camera.y += dy;
  }

  zoomAt(screenX, screenY, factor) {
    const before = this.screenToWorld(screenX, screenY);
    const zoom = clamp(this.camera.zoom * factor, 0.18, 3.2);
    if (zoom === this.camera.zoom) return;
    this.camera.zoom = zoom;
    this.camera.x = screenX - before.x * zoom;
    this.camera.y = screenY - before.y * zoom;
  }

  getBounds(padding = 120) {
    if (this.nodes.size === 0) {
      return {
        minX: -420 - padding,
        minY: -300 - padding,
        maxX: 420 + padding,
        maxY: 300 + padding,
      };
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of this.nodes.values()) {
      minX = Math.min(minX, node.x - node.radius);
      minY = Math.min(minY, node.y - node.radius);
      maxX = Math.max(maxX, node.x + node.radius);
      maxY = Math.max(maxY, node.y + node.radius);
    }
    return {
      minX: minX - padding,
      minY: minY - padding,
      maxX: maxX + padding,
      maxY: maxY + padding,
    };
  }

  fit(padding = 90, maxZoom = 1.3) {
    if (this.nodes.size === 0) {
      this.camera = { x: this.width / 2, y: this.height / 2, zoom: 1 };
      return;
    }
    const bounds = this.getBounds(0);
    const boundsWidth = Math.max(1, bounds.maxX - bounds.minX);
    const boundsHeight = Math.max(1, bounds.maxY - bounds.minY);
    const zoom = clamp(
      Math.min(
        (this.width - padding * 2) / boundsWidth,
        (this.height - padding * 2) / boundsHeight,
      ),
      0.18,
      maxZoom,
    );
    this.camera.zoom = zoom;
    this.camera.x = this.width / 2 - ((bounds.minX + bounds.maxX) / 2) * zoom;
    this.camera.y = this.height / 2 - ((bounds.minY + bounds.maxY) / 2) * zoom;
  }

  focus(url, zoom = 1.15) {
    const node = this.nodes.get(url);
    if (!node) return;
    this.camera.zoom = zoom;
    this.camera.x = this.width / 2 - node.x * zoom;
    this.camera.y = this.height / 2 - node.y * zoom;
  }

  pick(screenX, screenY) {
    const point = this.screenToWorld(screenX, screenY);
    const slop = 7 / this.camera.zoom;
    const nodes = Array.from(this.nodes.values());
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index];
      if (Math.hypot(node.x - point.x, node.y - point.y) <= node.radius + slop) {
        return node;
      }
    }
    return null;
  }

  step(dt) {
    const step = clamp(dt, 0, 0.05);
    this.time += step;
    for (const node of this.nodes.values()) {
      node.appear = Math.min(1, node.appear + step * 4);
      node.pulse = Math.max(0, node.pulse - step * 1.8);
    }
    if (!this.paused) {
      this.temperature = Math.max(0.16, this.temperature - step * 0.2);
      this._simulate(step * (0.35 + this.temperature));
    }
  }

  _simulate(dt) {
    const nodes = Array.from(this.nodes.values());
    if (nodes.length === 0) return;

    const cellSize = 130;
    const grid = new Map();
    for (const node of nodes) {
      const cellX = Math.floor(node.x / cellSize);
      const cellY = Math.floor(node.y / cellSize);
      const key = `${cellX},${cellY}`;
      let bucket = grid.get(key);
      if (!bucket) {
        bucket = [];
        grid.set(key, bucket);
      }
      bucket.push(node);
    }

    // Repulsion and collision, evaluated once per pair using the spatial hash.
    for (const node of nodes) {
      const cellX = Math.floor(node.x / cellSize);
      const cellY = Math.floor(node.y / cellSize);
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
          const bucket = grid.get(`${cellX + offsetX},${cellY + offsetY}`);
          if (!bucket) continue;
          for (const other of bucket) {
            if (other === node || other.id <= node.id) continue;
            let dx = node.x - other.x;
            let dy = node.y - other.y;
            let distanceSquared = dx * dx + dy * dy;
            if (distanceSquared < 1e-4) {
              dx = (node.seed - 0.5) * 2;
              dy = (other.seed - 0.5) * 2;
              distanceSquared = dx * dx + dy * dy || 1;
            }
            const distance = Math.sqrt(distanceSquared);
            const minDistance = node.radius + other.radius + 14;
            let force = 150000 / (distanceSquared + 900);
            if (distance < minDistance) {
              force += (minDistance - distance) * 1.9;
            }
            const fx = (dx / distance) * force;
            const fy = (dy / distance) * force;
            node.vx += fx * dt;
            node.vy += fy * dt;
            other.vx -= fx * dt;
            other.vy -= fy * dt;
          }
        }
      }
    }

    // Link springs.
    for (const link of this.links.values()) {
      const source = this.nodes.get(link.source);
      const target = this.nodes.get(link.target);
      if (!source || !target) continue;
      let dx = target.x - source.x;
      let dy = target.y - source.y;
      const distance = Math.hypot(dx, dy) || 1;
      const rest = 92 + Math.min(80, (source.depth + target.depth) * 7);
      const force = (distance - rest) * 3.1;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      source.vx += fx * dt;
      source.vy += fy * dt;
      target.vx -= fx * dt;
      target.vy -= fy * dt;
    }

    // Gravity keeps the layout centered and gently clusters the root.
    for (const node of nodes) {
      const gravity = node.isRoot ? 0.55 : 0.09;
      node.vx -= node.x * gravity * dt;
      node.vy -= node.y * gravity * dt;

      const damping = Math.exp(-3.4 * dt);
      node.vx *= damping;
      node.vy *= damping;

      const speed = Math.hypot(node.vx, node.vy);
      const maxSpeed = 260;
      if (speed > maxSpeed) {
        node.vx = (node.vx / speed) * maxSpeed;
        node.vy = (node.vy / speed) * maxSpeed;
      }

      if (!node.dragging) {
        node.x += node.vx * dt;
        node.y += node.vy * dt;
      }
      node.x = clamp(node.x, -6000, 6000);
      node.y = clamp(node.y, -6000, 6000);
    }
  }

  applyCamera(ctx) {
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(this.camera.x, this.camera.y);
    ctx.scale(this.camera.zoom, this.camera.zoom);
  }

  drawWorld(ctx) {
    this._drawLinks(ctx);
    for (const node of this.nodes.values()) this._drawNode(ctx, node);
  }

  _stateOf(node) {
    if (node.isRoot) return ROOT;
    return STATE[node.state] || STATE.discovered;
  }

  _drawLinks(ctx) {
    const zoom = this.camera.zoom;
    const lineWidth = 1 / zoom;
    ctx.save();
    for (const link of this.links.values()) {
      const source = this.nodes.get(link.source);
      const target = this.nodes.get(link.target);
      if (!source || !target) continue;
      const color = this._stateOf(target);
      const emphasized =
        (this.hovered && (this.hovered.id === source.id || this.hovered.id === target.id)) ||
        (this.selected && (this.selected.id === source.id || this.selected.id === target.id));
      const fresh = this.time - target.lastActive < 2.2;

      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(target.x, target.y);
      ctx.strokeStyle = rgba(color.rgb, emphasized ? 0.55 : fresh ? 0.3 : 0.14);
      ctx.lineWidth = (emphasized ? 1.8 : 1) / zoom;
      ctx.stroke();

      // Travelling packet. Only draw enough of them to stay readable.
      if (this.links.size < 320 || emphasized || fresh) {
        const travel = (this.time * 0.28 + link.phase) % 1;
        const x = lerp(source.x, target.x, travel);
        const y = lerp(source.y, target.y, travel);
        ctx.beginPath();
        ctx.arc(x, y, (emphasized ? 2.4 : 1.5) / zoom, 0, TAU);
        ctx.fillStyle = rgba(color.rgb, emphasized ? 0.95 : 0.55);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  _drawNode(ctx, node) {
    const zoom = this.camera.zoom;
    const color = this._stateOf(node);
    const appear = 0.55 + 0.45 * node.appear;
    const pulse = node.state === "fetching" ? 1 + Math.sin(this.time * 7) * 0.14 : 1;
    const radius = node.radius * appear * pulse;
    const isActive =
      (this.hovered && this.hovered.id === node.id) ||
      (this.selected && this.selected.id === node.id);

    ctx.save();

    // Soft halo.
    const halo = ctx.createRadialGradient(
      node.x,
      node.y,
      radius * 0.4,
      node.x,
      node.y,
      radius * 3.4,
    );
    halo.addColorStop(0, rgba(color.rgb, isActive ? 0.34 : 0.18));
    halo.addColorStop(0.55, rgba(color.rgb, 0.06));
    halo.addColorStop(1, rgba(color.rgb, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius * 3.4, 0, TAU);
    ctx.fill();

    // Outer ring.
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius + 3 / zoom, 0, TAU);
    ctx.strokeStyle = rgba(color.rgb, isActive ? 0.9 : 0.38);
    ctx.lineWidth = (isActive ? 1.8 : 1) / zoom;
    ctx.stroke();

    // Core.
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, TAU);
    ctx.fillStyle = rgba(color.rgb, node.state === "discovered" ? 0.5 : 0.86);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(node.x, node.y, radius * 0.36, 0, TAU);
    ctx.fillStyle = "rgba(240,255,255,0.92)";
    ctx.fill();

    if (node.state === "fetching") {
      ctx.beginPath();
      ctx.setLineDash([3 / zoom, 4 / zoom]);
      ctx.lineDashOffset = -this.time * 14;
      ctx.arc(node.x, node.y, radius + 7 / zoom, 0, TAU);
      ctx.strokeStyle = rgba(color.rgb, 0.8);
      ctx.lineWidth = 1.2 / zoom;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (node.isRoot) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius + 7 / zoom, 0, TAU);
      ctx.strokeStyle = rgba(ROOT.rgb, 0.25);
      ctx.lineWidth = 1 / zoom;
      ctx.stroke();
    }

    if (isActive) {
      const bracketRadius = radius + 10 / zoom;
      ctx.translate(node.x, node.y);
      ctx.rotate(this.time * 0.55);
      ctx.strokeStyle = rgba(color.rgb, 0.85);
      ctx.lineWidth = 1.2 / zoom;
      for (let corner = 0; corner < 4; corner += 1) {
        ctx.save();
        ctx.rotate((corner * Math.PI) / 2);
        ctx.beginPath();
        ctx.moveTo(bracketRadius, bracketRadius - 6 / zoom);
        ctx.lineTo(bracketRadius, bracketRadius);
        ctx.lineTo(bracketRadius - 6 / zoom, bracketRadius);
        ctx.stroke();
        ctx.restore();
      }
    }

    ctx.restore();
  }

  drawLabels(ctx) {
    if (!this.showLabels) return;
    const zoom = this.camera.zoom;
    if (zoom < 0.42) return;

    const candidates = Array.from(this.nodes.values())
      .filter((node) => {
        if (
          this.hovered === node ||
          this.selected === node ||
          node.isRoot ||
          this.time - node.lastActive < 4.5
        ) {
          return true;
        }
        return this.nodes.size < 26 || node.depth <= 1;
      })
      .sort((a, b) => {
        const priority = (node) =>
          (node === this.hovered ? 100 : 0) +
          (node === this.selected ? 90 : 0) +
          (node.isRoot ? 50 : 0) +
          (this.time - node.lastActive < 4.5 ? 20 : 0) -
          node.depth;
        return priority(b) - priority(a);
      });

    const fontPx = 11 / zoom;
    ctx.save();
    ctx.font = `${fontPx}px "Cascadia Code", "JetBrains Mono", ui-monospace, monospace`;
    ctx.textBaseline = "middle";
    const occupied = [];

    for (const node of candidates) {
      const screen = this.worldToScreen(node);
      if (
        screen.x < -80 ||
        screen.y < -20 ||
        screen.x > this.width + 80 ||
        screen.y > this.height + 20
      ) {
        continue;
      }

      const text = truncate(node.label || labelFor(node.url), this.hovered === node ? 46 : 30);
      const textWidth = ctx.measureText(text).width * zoom;
      const x = node.x + node.radius + 7 / zoom;
      const y = node.y - 1 / zoom;
      const screenX = screen.x + (node.radius + 7 / zoom) * zoom;
      const screenY = screen.y - 1 / zoom * zoom;
      const box = {
        x: screenX - 4,
        y: screenY - 9,
        w: textWidth + 8,
        h: 18,
      };

      const collision = occupied.some(
        (other) =>
          box.x < other.x + other.w &&
          box.x + box.w > other.x &&
          box.y < other.y + other.h &&
          box.y + box.h > other.y,
      );
      if (collision) continue;
      occupied.push(box);

      const color = this._stateOf(node);
      const highlighted =
        this.hovered === node || this.selected === node || node.isRoot;

      ctx.fillStyle = highlighted ? "rgba(4,16,24,0.88)" : "rgba(4,12,18,0.62)";
      const padding = 3 / zoom;
      const height = 14 / zoom;
      ctx.beginPath();
      ctx.roundRect(
        x - padding,
        y - height / 2,
        textWidth / zoom + padding * 2,
        height,
        2 / zoom,
      );
      ctx.fill();

      ctx.fillStyle = highlighted
        ? rgba(color.rgb, 1)
        : `rgba(198,242,250,${this.nodes.size > 120 ? 0.48 : 0.68})`;
      ctx.fillText(text, x, y);
    }
    ctx.restore();
  }
}
