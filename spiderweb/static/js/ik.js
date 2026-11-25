/**
 * Inverse kinematics and small vector helpers for SpiderWeb.
 *
 * Pure math only: this module has no DOM dependencies so it can be
 * unit-tested with Node as well as imported by the browser modules.
 */

export const TAU = Math.PI * 2;

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const lerp = (a, b, t) => a + (b - a) * t;

/** Frame-rate independent exponential smoothing. */
export const damp = (current, target, lambda, dt) =>
  lerp(current, target, 1 - Math.exp(-lambda * dt));

export const easeInOut = (t) =>
  t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

export const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

export const angleTo = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(angle) {
  let a = angle % TAU;
  if (a > Math.PI) a -= TAU;
  if (a <= -Math.PI) a += TAU;
  return a;
}

/** Turn `current` toward `target` by at most `maxStep` radians. */
export function approachAngle(current, target, maxStep) {
  const delta = wrapAngle(target - current);
  return current + clamp(delta, -maxStep, maxStep);
}

/** Unit vector from a to b, or (1, 0) for a degenerate pair. */
export function direction(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return { x: 1, y: 0, length: 0 };
  return { x: dx / length, y: dy / length, length };
}

/**
 * Analytic two-bone IK.
 *
 * Returns the elbow/knee position plus the reachable end effector. If the
 * target is out of range the end effector is clamped to the maximum reach,
 * which is handy for tentacles that should stretch rather than snap.
 */
export function solveTwoBone(origin, target, upperLength, lowerLength, bend = 1) {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const rawDistance = Math.hypot(dx, dy);
  const maxReach = upperLength + lowerLength;
  const minReach = Math.abs(upperLength - lowerLength) + 1e-4;
  const reach = clamp(rawDistance, minReach, maxReach);
  const baseAngle = Math.atan2(dy, dx);

  const cosA = clamp(
    (upperLength * upperLength + reach * reach - lowerLength * lowerLength) /
      (2 * upperLength * reach),
    -1,
    1,
  );
  const jointAngle = baseAngle + bend * Math.acos(cosA);

  return {
    joint: {
      x: origin.x + Math.cos(jointAngle) * upperLength,
      y: origin.y + Math.sin(jointAngle) * upperLength,
    },
    end: {
      x: origin.x + Math.cos(baseAngle) * reach,
      y: origin.y + Math.sin(baseAngle) * reach,
    },
    reachable: rawDistance <= maxReach,
    distance: rawDistance,
  };
}

/**
 * FABRIK solver for a chain of points.
 *
 * `points[0]` is the pinned root and `lengths[i]` is the distance between
 * points[i] and points[i + 1]. The array is mutated in place; the target is
 * treated as a soft attractor for the tip.
 */
export function solveFABRIK(points, lengths, target, options = {}) {
  const { iterations = 8, tolerance = 0.6 } = options;
  const count = points.length;
  if (count < 2 || lengths.length < count - 1) {
    return { reachable: true, iterations: 0 };
  }

  const rootX = points[0].x;
  const rootY = points[0].y;
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const toTarget = Math.hypot(target.x - rootX, target.y - rootY);

  // Target is farther than the chain can reach: stretch straight toward it.
  if (toTarget > total) {
    for (let i = 1; i < count; i += 1) {
      const previous = points[i - 1];
      const dx = target.x - previous.x;
      const dy = target.y - previous.y;
      const length = Math.hypot(dx, dy) || 1;
      points[i].x = previous.x + (dx / length) * lengths[i - 1];
      points[i].y = previous.y + (dy / length) * lengths[i - 1];
    }
    return { reachable: false, iterations: 0 };
  }

  let used = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    used = iteration + 1;

    // Backward pass: pull the tip onto the target, walk toward the root.
    points[count - 1].x = target.x;
    points[count - 1].y = target.y;
    for (let i = count - 2; i >= 0; i -= 1) {
      const dx = points[i].x - points[i + 1].x;
      const dy = points[i].y - points[i + 1].y;
      const length = Math.hypot(dx, dy) || 1;
      points[i].x = points[i + 1].x + (dx / length) * lengths[i];
      points[i].y = points[i + 1].y + (dy / length) * lengths[i];
    }

    // Forward pass: pin the root back in place.
    points[0].x = rootX;
    points[0].y = rootY;
    for (let i = 1; i < count; i += 1) {
      const dx = points[i].x - points[i - 1].x;
      const dy = points[i].y - points[i - 1].y;
      const length = Math.hypot(dx, dy) || 1;
      points[i].x = points[i - 1].x + (dx / length) * lengths[i - 1];
      points[i].y = points[i - 1].y + (dy / length) * lengths[i - 1];
    }

    const miss = Math.hypot(
      points[count - 1].x - target.x,
      points[count - 1].y - target.y,
    );
    if (miss <= tolerance) break;
  }

  return { reachable: true, iterations: used };
}
