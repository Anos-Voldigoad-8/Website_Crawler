/**
 * Centipede: the living mascot of SpiderWeb.
 *
 * The creature has a procedural segmented body that trails a steered head,
 * plus two rows of tentacle legs. Each leg is a FABRIK chain (inverse
 * kinematics) with planted foot targets and a stepping gait. Everything is
 * drawn in world coordinates so it can crawl across the crawl graph.
 */

import {
  TAU,
  clamp,
  damp,
  lerp,
  easeInOut,
  solveFABRIK,
  approachAngle,
} from "./ik.js";

const LEG_JOINTS = 5;
const LEG_LENGTHS = [14, 13, 12, 10];
const ANTENNA_JOINTS = 5;
const ANTENNA_LENGTHS = [11, 10, 9, 8];

const COLORS = {
  left: "#45e8ff",
  right: "#ff4fb8",
  body: "#5cf6ff",
  bodyDeep: "#073c4f",
  head: "#ff5cc8",
  eye: "#f6ffff",
  target: "rgba(77, 243, 255, 0.34)",
};

const vec = (x = 0, y = 0) => ({ x, y });

function makeChain(count, lengths) {
  return {
    joints: Array.from({ length: count }, () => vec()),
    lengths,
  };
}

export class Centipede {
  constructor(options = {}) {
    this.segmentCount = options.segments ?? 18;
    this.segmentSpacing = options.segmentSpacing ?? 18;
    this.bodyWidth = options.bodyWidth ?? 16;
    this.maxSpeed = options.maxSpeed ?? 96;
    this.waveAmp = options.waveAmp ?? 5.5;
    this.legReach = options.legReach ?? 38;
    this.stepThreshold = options.stepThreshold ?? 25;
    this.visible = options.visible ?? true;
    this.paused = false;

    this.time = Math.random() * 100;
    this.heading = 0;
    this.speed = 0;
    this.phase = Math.random() * TAU;
    this.target = vec();
    this.bounds = { minX: -800, minY: -600, maxX: 800, maxY: 600 };

    this.segments = Array.from({ length: this.segmentCount }, () => ({
      x: 0,
      y: 0,
      angle: 0,
    }));

    this.legs = [];
    for (let index = 1; index < this.segmentCount; index += 1) {
      this.legs.push(this._makeLeg(index, -1));
      this.legs.push(this._makeLeg(index, 1));
    }

    this.antennae = [this._makeAntenna(-1), this._makeAntenna(1)];
    this.spawn(0, 0, 0);
  }

  _makeLeg(segmentIndex, side) {
    return {
      segmentIndex,
      side,
      phase: segmentIndex * 0.62 + (side > 0 ? Math.PI : 0) + Math.random() * 0.25,
      ...makeChain(LEG_JOINTS, LEG_LENGTHS),
      root: vec(),
      foot: vec(),
      from: vec(),
      to: vec(),
      stepping: false,
      solved: false,
      stepT: 1,
      duration: 0.16,
      lift: 0,
      ripple: 0,
    };
  }

  _makeAntenna(side) {
    return {
      side,
      phase: Math.random() * TAU,
      ...makeChain(ANTENNA_JOINTS, ANTENNA_LENGTHS),
      root: vec(),
      tip: vec(),
      solved: false,
    };
  }

  /** Place the whole creature at a point and heading. */
  spawn(x, y, heading = 0) {
    this.heading = heading;
    const dx = Math.cos(heading);
    const dy = Math.sin(heading);

    this.segments.forEach((segment, index) => {
      segment.x = x - dx * this.segmentSpacing * index;
      segment.y = y - dy * this.segmentSpacing * index;
      segment.angle = heading;
    });

    this.speed = 0;
    this.target = { x: x + dx * 260, y: y + dy * 260 };

    for (const leg of this.legs) {
      leg.stepping = false;
      leg.solved = false;
      leg.stepT = 1;
      leg.lift = 0;
      leg.ripple = 0;
    }
    for (const antenna of this.antennae) antenna.solved = false;
  }

  setTarget(pointOrX, y) {
    if (typeof pointOrX === "number") {
      this.target.x = pointOrX;
      this.target.y = y;
    } else if (pointOrX) {
      this.target.x = pointOrX.x;
      this.target.y = pointOrX.y;
    }
  }

  setBounds(minX, minY, maxX, maxY) {
    this.bounds = { minX, minY, maxX, maxY };
  }

  update(dt) {
    if (this.paused) return;
    const step = clamp(dt, 0, 0.05);
    this.time += step;
    this._steer(step);
    this._solveBody(step);
    this._solveLegs(step);
    this._solveAntennae();
  }

  _steer(dt) {
    const head = this.segments[0];
    let dx = this.target.x - head.x;
    let dy = this.target.y - head.y;
    const targetDistance = Math.hypot(dx, dy) || 1;
    let ax = dx / targetDistance;
    let ay = dy / targetDistance;

    // Soft repulsion from the edges of the patrol area.
    const margin = 110;
    const { minX, minY, maxX, maxY } = this.bounds;
    if (head.x < minX + margin) ax += (1 - (head.x - minX) / margin) * 1.7;
    if (head.x > maxX - margin) ax -= (1 - (maxX - head.x) / margin) * 1.7;
    if (head.y < minY + margin) ay += (1 - (head.y - minY) / margin) * 1.7;
    if (head.y > maxY - margin) ay -= (1 - (maxY - head.y) / margin) * 1.7;

    const desiredHeading = Math.atan2(ay, ax);
    const wander =
      Math.sin(this.time * 1.65 + this.phase) * 0.22 +
      Math.sin(this.time * 0.41 + 1.3) * 0.12;

    const desiredSpeed =
      targetDistance < 34
        ? this.maxSpeed * 0.16
        : this.maxSpeed * clamp(targetDistance / 230, 0.35, 1);
    const turnRate = 2.3 + clamp(1 - targetDistance / 420, 0, 1) * 2.1;

    this.heading = approachAngle(
      this.heading,
      desiredHeading + wander,
      turnRate * dt,
    );
    this.speed = damp(this.speed, desiredSpeed, 3.4, dt);

    head.x += Math.cos(this.heading) * this.speed * dt;
    head.y += Math.sin(this.heading) * this.speed * dt;
    head.angle = this.heading;

    head.x = clamp(head.x, minX + 24, maxX - 24);
    head.y = clamp(head.y, minY + 24, maxY - 24);
  }

  _solveBody(dt) {
    const segments = this.segments;
    const spacing = this.segmentSpacing;

    for (let index = 1; index < segments.length; index += 1) {
      const previous = segments[index - 1];
      const segment = segments[index];

      let dx = segment.x - previous.x;
      let dy = segment.y - previous.y;
      const distance = Math.hypot(dx, dy) || 1;
      const ux = dx / distance;
      const uy = dy / distance;
      const nx = -uy;
      const ny = ux;

      const wave =
        Math.sin(this.time * 5.2 - index * 0.66) *
        this.waveAmp *
        Math.min(1, index / 4) *
        (0.35 + 0.65 * (this.speed / this.maxSpeed));

      const targetX = previous.x - ux * spacing + nx * wave;
      const targetY = previous.y - uy * spacing + ny * wave;

      segment.x = damp(segment.x, targetX, 15, dt);
      segment.y = damp(segment.y, targetY, 15, dt);

      // Hard distance constraint keeps the body from stretching.
      dx = segment.x - previous.x;
      dy = segment.y - previous.y;
      const constrained = Math.hypot(dx, dy) || 1;
      segment.x = previous.x + (dx / constrained) * spacing;
      segment.y = previous.y + (dy / constrained) * spacing;
      segment.angle = Math.atan2(previous.y - segment.y, previous.x - segment.x);
    }
  }

  _solveLegs(dt) {
    for (const leg of this.legs) {
      const segment = this.segments[leg.segmentIndex];
      const angle = segment.angle;
      const forwardX = Math.cos(angle);
      const forwardY = Math.sin(angle);
      const normalX = -forwardY;
      const normalY = forwardX;

      leg.root.x = segment.x + normalX * leg.side * this.bodyWidth * 0.42;
      leg.root.y = segment.y + normalY * leg.side * this.bodyWidth * 0.42;

      const taper = 0.78 + 0.22 * Math.sin((leg.segmentIndex / this.segmentCount) * Math.PI);
      const gait = Math.sin(this.time * 4.4 + leg.phase) * (3 + 4 * (this.speed / this.maxSpeed));
      const reach = this.legReach * taper;

      const idealX = leg.root.x + normalX * leg.side * reach + forwardX * gait;
      const idealY = leg.root.y + normalY * leg.side * reach + forwardY * gait;

      if (!leg.solved) {
        leg.foot.x = idealX;
        leg.foot.y = idealY;
      }

      if (leg.stepping) {
        leg.stepT += dt / leg.duration;
        if (leg.stepT >= 1) {
          leg.stepping = false;
          leg.stepT = 1;
          leg.foot.x = leg.to.x;
          leg.foot.y = leg.to.y;
          leg.lift = 0;
          leg.ripple = 1;
        } else {
          const t = easeInOut(leg.stepT);
          leg.foot.x = lerp(leg.from.x, leg.to.x, t);
          leg.foot.y = lerp(leg.from.y, leg.to.y, t);
          leg.lift = Math.sin(Math.PI * leg.stepT);
        }
      } else {
        const stretched = Math.hypot(leg.foot.x - idealX, leg.foot.y - idealY);
        if (stretched > this.stepThreshold) {
          leg.stepping = true;
          leg.stepT = 0;
          leg.lift = 0;
          leg.from.x = leg.foot.x;
          leg.from.y = leg.foot.y;
          leg.to.x = idealX;
          leg.to.y = idealY;
          leg.duration = clamp(0.11 + stretched / 900, 0.11, 0.28);
        }
      }
      leg.ripple = Math.max(0, leg.ripple - dt * 3.4);

      const joints = leg.joints;
      joints[0].x = leg.root.x;
      joints[0].y = leg.root.y;
      if (!leg.solved) {
        for (let index = 1; index < joints.length; index += 1) {
          const t = index / (joints.length - 1);
          joints[index].x = lerp(leg.root.x, leg.foot.x, t);
          joints[index].y = lerp(leg.root.y, leg.foot.y, t);
        }
        leg.solved = true;
      }

      solveFABRIK(joints, leg.lengths, leg.foot, { iterations: 6, tolerance: 0.7 });

      // Add a travelling ripple so the solved chain reads as a tentacle
      // rather than a rigid two-bone leg.
      for (let index = 1; index < joints.length - 1; index += 1) {
        const t = index / (joints.length - 1);
        const wobble =
          Math.sin(this.time * 5.8 + leg.phase + index * 1.35) *
          (1.5 + leg.lift * 2.2) *
          Math.sin(Math.PI * t);
        joints[index].x += normalX * wobble;
        joints[index].y += normalY * wobble;
      }
    }
  }

  _solveAntennae() {
    const head = this.segments[0];
    const forwardX = Math.cos(this.heading);
    const forwardY = Math.sin(this.heading);
    const normalX = -forwardY;
    const normalY = forwardX;

    for (const antenna of this.antennae) {
      antenna.root.x = head.x + forwardX * this.bodyWidth * 0.5 + normalX * antenna.side * 4;
      antenna.root.y = head.y + forwardY * this.bodyWidth * 0.5 + normalY * antenna.side * 4;

      const wave = Math.sin(this.time * 3.2 + antenna.phase) * 7;
      antenna.tip.x =
        head.x +
        forwardX * 54 +
        normalX * antenna.side * (24 + wave) +
        Math.cos(this.time * 1.4) * 3;
      antenna.tip.y =
        head.y +
        forwardY * 54 +
        normalY * antenna.side * (24 + wave) +
        Math.sin(this.time * 1.4) * 3;

      const joints = antenna.joints;
      joints[0].x = antenna.root.x;
      joints[0].y = antenna.root.y;
      if (!antenna.solved) {
        for (let index = 1; index < joints.length; index += 1) {
          const t = index / (joints.length - 1);
          joints[index].x = lerp(antenna.root.x, antenna.tip.x, t);
          joints[index].y = lerp(antenna.root.y, antenna.tip.y, t);
        }
        antenna.solved = true;
      }

      solveFABRIK(joints, antenna.lengths, antenna.tip, {
        iterations: 5,
        tolerance: 0.8,
      });
    }
  }

  draw(ctx) {
    if (!this.visible) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    this._drawTarget(ctx);
    for (const antenna of this.antennae) this._drawAntenna(ctx, antenna);
    for (const leg of this.legs) this._drawLeg(ctx, leg);
    for (let index = this.segments.length - 1; index >= 0; index -= 1) {
      this._drawSegment(ctx, this.segments[index], index);
    }
    this._drawHead(ctx);
    ctx.restore();
  }

  _drawTarget(ctx) {
    const head = this.segments[0];
    if (Math.hypot(this.target.x - head.x, this.target.y - head.y) < 42) return;

    ctx.save();
    ctx.translate(this.target.x, this.target.y);
    ctx.rotate(this.time * 0.8);
    ctx.strokeStyle = COLORS.target;
    ctx.lineWidth = 1.2;
    const radius = 9;
    for (let corner = 0; corner < 4; corner += 1) {
      ctx.save();
      ctx.rotate((corner * Math.PI) / 2);
      ctx.beginPath();
      ctx.moveTo(radius, radius - 5);
      ctx.lineTo(radius, radius);
      ctx.lineTo(radius - 5, radius);
      ctx.stroke();
      ctx.restore();
    }
    ctx.beginPath();
    ctx.arc(0, 0, 2, 0, TAU);
    ctx.fillStyle = COLORS.target;
    ctx.fill();
    ctx.restore();
  }

  _drawLeg(ctx, leg) {
    const color = leg.side < 0 ? COLORS.left : COLORS.right;
    const joints = leg.joints;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    // Wide soft under-glow.
    ctx.beginPath();
    ctx.moveTo(joints[0].x, joints[0].y);
    for (let index = 1; index < joints.length; index += 1) {
      ctx.lineTo(joints[index].x, joints[index].y);
    }
    ctx.strokeStyle = leg.side < 0 ? "rgba(69,232,255,0.12)" : "rgba(255,79,184,0.12)";
    ctx.lineWidth = 7;
    ctx.stroke();

    // Tapered tentacle segments.
    for (let index = 1; index < joints.length; index += 1) {
      const t = index / (joints.length - 1);
      ctx.beginPath();
      ctx.moveTo(joints[index - 1].x, joints[index - 1].y);
      ctx.lineTo(joints[index].x, joints[index].y);
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.42 + t * 0.58;
      ctx.lineWidth = lerp(3.2, 1.05, t);
      ctx.stroke();
    }

    // Bioluminescent tip + landing ripple.
    const tip = joints[joints.length - 1];
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#f2ffff";
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 1.7 + leg.lift * 0.8, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;

    if (leg.ripple > 0) {
      ctx.strokeStyle = color;
      ctx.globalAlpha = leg.ripple * 0.45;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(leg.foot.x, leg.foot.y, (1 - leg.ripple) * 11 + 2, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawAntenna(ctx, antenna) {
    const joints = antenna.joints;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let index = 1; index < joints.length; index += 1) {
      const t = index / (joints.length - 1);
      ctx.beginPath();
      ctx.moveTo(joints[index - 1].x, joints[index - 1].y);
      ctx.lineTo(joints[index].x, joints[index].y);
      ctx.strokeStyle = COLORS.head;
      ctx.globalAlpha = 0.3 + t * 0.55;
      ctx.lineWidth = lerp(2.1, 0.7, t);
      ctx.stroke();
    }
    const tip = joints[joints.length - 1];
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#ffd6f4";
    ctx.shadowColor = COLORS.head;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 1.5, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  _drawSegment(ctx, segment, index) {
    const t = index / Math.max(1, this.segments.length - 1);
    const width =
      this.bodyWidth *
      (0.34 + 0.66 * (1 - t)) *
      (index === 0 ? 1.18 : 1);
    const length = this.segmentSpacing * (index === 0 ? 0.82 : 0.72);
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 4.5 - index * 0.55);

    ctx.save();
    ctx.translate(segment.x, segment.y);
    ctx.rotate(segment.angle);

    const gradient = ctx.createRadialGradient(
      -length * 0.15,
      -width * 0.22,
      1,
      0,
      0,
      width * 0.72,
    );
    gradient.addColorStop(0, index === 0 ? "#ff9bdd" : "#9bfbff");
    gradient.addColorStop(0.45, index === 0 ? "#c81f83" : "#0f8fa8");
    gradient.addColorStop(1, COLORS.bodyDeep);

    ctx.beginPath();
    ctx.ellipse(0, 0, length, width * 0.52, 0, 0, TAU);
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.strokeStyle = `rgba(92,246,255,${0.2 + pulse * 0.25})`;
    ctx.lineWidth = 1.1;
    ctx.stroke();

    // Carapace ridge.
    ctx.beginPath();
    ctx.moveTo(-length * 0.6, 0);
    ctx.lineTo(length * 0.55, 0);
    ctx.strokeStyle = `rgba(210,255,255,${0.1 + pulse * 0.16})`;
    ctx.lineWidth = 0.9;
    ctx.stroke();

    // Dorsal light.
    ctx.beginPath();
    ctx.arc(0, 0, 1.2 + pulse * 1.3, 0, TAU);
    ctx.fillStyle = index === 0 ? "#ffe3f7" : "#d9ffff";
    ctx.shadowColor = index === 0 ? COLORS.head : COLORS.body;
    ctx.shadowBlur = 7;
    ctx.fill();
    ctx.restore();
  }

  _drawHead(ctx) {
    const head = this.segments[0];
    const mandible = Math.sin(this.time * 7) * 0.35;

    ctx.save();
    ctx.translate(head.x, head.y);
    ctx.rotate(this.heading);

    // Mandibles.
    ctx.strokeStyle = "rgba(255,110,208,0.9)";
    ctx.lineWidth = 2;
    ctx.shadowColor = COLORS.head;
    ctx.shadowBlur = 8;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(this.bodyWidth * 0.62, side * 5);
      ctx.quadraticCurveTo(
        this.bodyWidth * 1.05,
        side * (7 + mandible * 8),
        this.bodyWidth * 0.86,
        side * (12 + mandible * 10),
      );
      ctx.stroke();
    }

    // Visor.
    ctx.beginPath();
    ctx.ellipse(this.bodyWidth * 0.38, 0, 6.5, this.bodyWidth * 0.4, 0, 0, TAU);
    ctx.fillStyle = "rgba(255,236,255,0.14)";
    ctx.fill();

    // Eyes.
    for (let index = -1; index <= 1; index += 1) {
      ctx.beginPath();
      ctx.arc(
        this.bodyWidth * 0.48,
        index * 4.4,
        index === 0 ? 1.9 : 1.4,
        0,
        TAU,
      );
      ctx.fillStyle = COLORS.eye;
      ctx.shadowColor = COLORS.head;
      ctx.shadowBlur = 9;
      ctx.fill();
    }
    ctx.restore();
  }
}
