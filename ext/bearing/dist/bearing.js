var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/core/conversions.js
var conversions_exports = {};
__export(conversions_exports, {
  dcosToLine: () => dcosToLine,
  dcosToPlane: () => dcosToPlane,
  lineOnPlane: () => lineOnPlane,
  lineToDcos: () => lineToDcos,
  linesToDcos: () => linesToDcos,
  planeIntersectionLine: () => planeIntersectionLine,
  planeToDcos: () => planeToDcos,
  planesToDcos: () => planesToDcos,
  rakeToDcos: () => rakeToDcos,
  rakeToLine: () => rakeToLine,
  rotateDcos: () => rotateDcos,
  rotateDcosArray: () => rotateDcosArray,
  strikeToDD: () => strikeToDD
});

// src/core/vec3.js
var vec3_exports = {};
__export(vec3_exports, {
  add: () => add,
  angle: () => angle,
  create: () => create,
  cross: () => cross,
  dot: () => dot,
  length: () => length,
  negate: () => negate,
  normalize: () => normalize,
  rotate: () => rotate,
  scale: () => scale,
  sub: () => sub
});
function create(x = 0, y = 0, z = 0) {
  return [x, y, z];
}
function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}
function length(v) {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}
function normalize(v) {
  const len = length(v);
  if (len === 0) return [0, 0, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}
function scale(v, s) {
  return [v[0] * s, v[1] * s, v[2] * s];
}
function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function negate(v) {
  return [-v[0], -v[1], -v[2]];
}
function angle(a, b) {
  const d = dot(normalize(a), normalize(b));
  return Math.acos(Math.max(-1, Math.min(1, d)));
}
function rotate(v, axis, theta) {
  const k = normalize(axis);
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const kDotV = dot(k, v);
  const kCrossV = cross(k, v);
  return [
    v[0] * cosT + kCrossV[0] * sinT + k[0] * kDotV * (1 - cosT),
    v[1] * cosT + kCrossV[1] * sinT + k[1] * kDotV * (1 - cosT),
    v[2] * cosT + kCrossV[2] * sinT + k[2] * kDotV * (1 - cosT)
  ];
}

// src/core/conversions.js
var DEG = Math.PI / 180;
var INV_DEG = 180 / Math.PI;
function planeToDcos(dd, dip) {
  const ddR = dd * DEG;
  const dipR = dip * DEG;
  return [
    -Math.sin(dipR) * Math.sin(ddR),
    -Math.sin(dipR) * Math.cos(ddR),
    -Math.cos(dipR)
  ];
}
function dcosToPlane(dcos) {
  let [x, y, z] = dcos;
  if (z > 0) {
    x = -x;
    y = -y;
    z = -z;
  }
  const dip = Math.acos(Math.max(-1, Math.min(1, -z))) * INV_DEG;
  let dd = Math.atan2(-x, -y) * INV_DEG;
  if (dd < 0) dd += 360;
  return [dd, dip];
}
function lineToDcos(trend, plunge) {
  const tR = trend * DEG;
  const pR = plunge * DEG;
  return [
    Math.cos(pR) * Math.sin(tR),
    Math.cos(pR) * Math.cos(tR),
    -Math.sin(pR)
  ];
}
function dcosToLine(dcos) {
  let [x, y, z] = dcos;
  if (z > 0) {
    x = -x;
    y = -y;
    z = -z;
  }
  const plunge = Math.asin(Math.max(-1, Math.min(1, -z))) * INV_DEG;
  let trend = Math.atan2(x, y) * INV_DEG;
  if (trend < 0) trend += 360;
  return [trend, plunge];
}
function strikeToDD(strike, dip) {
  return [(strike + 90) % 360, dip];
}
function planesToDcos(planes) {
  return planes.map(([dd, dip]) => planeToDcos(dd, dip));
}
function linesToDcos(lines) {
  return lines.map(([t, p]) => lineToDcos(t, p));
}
function rakeToDcos(dd, dip, rake) {
  const ddR = dd * DEG;
  const dR = dip * DEG;
  const rk = rake * DEG;
  return [
    Math.sin(rk) * Math.cos(dR) * Math.sin(ddR) - Math.cos(rk) * Math.cos(ddR),
    Math.sin(rk) * Math.cos(dR) * Math.cos(ddR) + Math.cos(rk) * Math.sin(ddR),
    -Math.sin(rk) * Math.sin(dR)
  ];
}
function rakeToLine(dd, dip, rake) {
  return dcosToLine(rakeToDcos(dd, dip, rake));
}
function lineOnPlane(dd, dip, trend, plunge) {
  const ddR = dd * DEG;
  const dR = dip * DEG;
  const tR = trend * DEG;
  const pR = plunge * DEG;
  const lx = Math.cos(pR) * Math.sin(tR);
  const ly = Math.cos(pR) * Math.cos(tR);
  const lz = -Math.sin(pR);
  const sx = -Math.cos(ddR);
  const sy = Math.sin(ddR);
  const dx = Math.cos(dR) * Math.sin(ddR);
  const dy = Math.cos(dR) * Math.cos(ddR);
  const dz = -Math.sin(dR);
  const alongStrike = lx * sx + ly * sy;
  const alongDip = lx * dx + ly * dy + lz * dz;
  return Math.atan2(alongDip, alongStrike) * INV_DEG;
}
function planeIntersectionLine(dd1, dip1, dd2, dip2) {
  const pole1 = planeToDcos(dd1, dip1);
  const pole2 = planeToDcos(dd2, dip2);
  const c = cross(pole1, pole2);
  const len = length(c);
  if (len < 1e-10) return null;
  const n = normalize(c);
  return dcosToLine(n);
}
function rotateDcos(dcos, axis, angle2) {
  const theta = angle2 * DEG;
  return rotate(dcos, axis, theta);
}
function rotateDcosArray(dcosArray, axis, angle2) {
  const theta = angle2 * DEG;
  return dcosArray.map((d) => rotate(d, axis, theta));
}

// src/core/curves.js
var curves_exports = {};
__export(curves_exports, {
  arc: () => arc,
  greatCircle: () => greatCircle,
  planeIntersection: () => planeIntersection,
  smallCircle: () => smallCircle
});
function greatCircle(pole, nPoints = 180) {
  const p = normalize(pole);
  const ref = Math.abs(p[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = normalize(cross(p, ref));
  const v = cross(p, u);
  const step = 2 * Math.PI / nPoints;
  const points = [];
  for (let i = 0; i <= nPoints; i++) {
    const theta = i * step;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    points.push([
      u[0] * cos + v[0] * sin,
      u[1] * cos + v[1] * sin,
      u[2] * cos + v[2] * sin
    ]);
  }
  return points;
}
function smallCircle(axis, halfAngle, nPoints = 180) {
  const a = normalize(axis);
  const ref = Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = normalize(cross(a, ref));
  const v = cross(a, u);
  const cosH = Math.cos(halfAngle);
  const sinH = Math.sin(halfAngle);
  const step = 2 * Math.PI / nPoints;
  const points = [];
  for (let i = 0; i <= nPoints; i++) {
    const theta = i * step;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    points.push([
      a[0] * cosH + (u[0] * cos + v[0] * sin) * sinH,
      a[1] * cosH + (u[1] * cos + v[1] * sin) * sinH,
      a[2] * cosH + (u[2] * cos + v[2] * sin) * sinH
    ]);
  }
  return points;
}
function arc(a, b, nPoints = 60) {
  const na = normalize(a);
  const nb = normalize(b);
  const theta = angle(na, nb);
  if (theta < 1e-10) return [na];
  const points = [];
  for (let i = 0; i <= nPoints; i++) {
    const t = i / nPoints;
    const angle2 = t * theta;
    points.push(rotate(na, normalize(cross(na, nb)), angle2));
  }
  return points;
}
function planeIntersection(pole1, pole2) {
  const c = cross(pole1, pole2);
  const len = length(c);
  if (len < 1e-10) return null;
  const n = normalize(c);
  return [n, negate(n)];
}

// src/core/mat3.js
var mat3_exports = {};
__export(mat3_exports, {
  identity: () => identity,
  multiply: () => multiply,
  orthonormalize: () => orthonormalize,
  rotationFromAxisAngle: () => rotationFromAxisAngle,
  transformVec3: () => transformVec3,
  transpose: () => transpose
});
function identity() {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}
function multiply(a, b) {
  return [
    a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
    a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
    a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
    a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
    a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
    a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
    a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
    a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
    a[6] * b[2] + a[7] * b[5] + a[8] * b[8]
  ];
}
function transformVec3(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2]
  ];
}
function rotationFromAxisAngle(axis, theta) {
  const [kx, ky, kz] = axis;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const t = 1 - c;
  return [
    c + kx * kx * t,
    kx * ky * t - kz * s,
    kx * kz * t + ky * s,
    ky * kx * t + kz * s,
    c + ky * ky * t,
    ky * kz * t - kx * s,
    kz * kx * t - ky * s,
    kz * ky * t + kx * s,
    c + kz * kz * t
  ];
}
function transpose(m) {
  return [
    m[0],
    m[3],
    m[6],
    m[1],
    m[4],
    m[7],
    m[2],
    m[5],
    m[8]
  ];
}
function orthonormalize(m) {
  let r0 = [m[0], m[1], m[2]];
  let r1 = [m[3], m[4], m[5]];
  let r2;
  let len = Math.sqrt(r0[0] * r0[0] + r0[1] * r0[1] + r0[2] * r0[2]);
  r0 = [r0[0] / len, r0[1] / len, r0[2] / len];
  let d = r1[0] * r0[0] + r1[1] * r0[1] + r1[2] * r0[2];
  r1 = [r1[0] - d * r0[0], r1[1] - d * r0[1], r1[2] - d * r0[2]];
  len = Math.sqrt(r1[0] * r1[0] + r1[1] * r1[1] + r1[2] * r1[2]);
  r1 = [r1[0] / len, r1[1] / len, r1[2] / len];
  r2 = [
    r0[1] * r1[2] - r0[2] * r1[1],
    r0[2] * r1[0] - r0[0] * r1[2],
    r0[0] * r1[1] - r0[1] * r1[0]
  ];
  return [
    r0[0],
    r0[1],
    r0[2],
    r1[0],
    r1[1],
    r1[2],
    r2[0],
    r2[1],
    r2[2]
  ];
}

// src/projections/equal-area.js
var equal_area_exports = {};
__export(equal_area_exports, {
  inverse: () => inverse,
  project: () => project
});
function project(dcos) {
  let [x, y, z] = dcos;
  if (z > 0) {
    x = -x;
    y = -y;
    z = -z;
  }
  const denom = 1 - z;
  const scale2 = Math.sqrt(2 / denom);
  return [x * scale2, y * scale2];
}
function inverse(px, py) {
  const r2 = px * px + py * py;
  if (r2 > 2) return null;
  const z = -(1 - r2 / 2);
  const scale2 = Math.sqrt(1 - r2 / 4);
  return [px * scale2, py * scale2, z];
}

// src/projections/equal-angle.js
var equal_angle_exports = {};
__export(equal_angle_exports, {
  inverse: () => inverse2,
  project: () => project2
});
function project2(dcos) {
  let [x, y, z] = dcos;
  if (z > 0) {
    x = -x;
    y = -y;
    z = -z;
  }
  const denom = 1 - z;
  return [x / denom, y / denom];
}
function inverse2(px, py) {
  const r2 = px * px + py * py;
  if (r2 > 1) return null;
  const denom = 1 + r2;
  return [
    2 * px / denom,
    2 * py / denom,
    -(1 - r2) / denom
  ];
}

// src/render/net.js
function generateNet(interval = 10, type = "equatorial") {
  return type === "polar" ? generatePolarNet(interval) : generateEquatorialNet(interval);
}
function generateEquatorialNet(interval) {
  const DEG4 = Math.PI / 180;
  const greatCircles = [];
  const smallCircles = [];
  for (let alpha = 0; alpha < 180; alpha += interval) {
    const alphaR = alpha * DEG4;
    greatCircles.push(
      greatCircle([Math.sin(alphaR), 0, Math.cos(alphaR)], 360)
    );
  }
  for (let alpha = interval; alpha < 180; alpha += interval) {
    smallCircles.push(
      smallCircle([0, 1, 0], alpha * DEG4, 360)
    );
  }
  return { greatCircles, smallCircles };
}
function generatePolarNet(interval) {
  const DEG4 = Math.PI / 180;
  const greatCircles = [];
  const smallCircles = [];
  for (let az = 0; az < 180; az += interval) {
    const azR = az * DEG4;
    greatCircles.push(
      greatCircle([Math.cos(azR), -Math.sin(azR), 0], 360)
    );
  }
  for (let dip = interval; dip <= 90; dip += interval) {
    smallCircles.push(
      smallCircle([0, 0, -1], dip * DEG4, 360)
    );
  }
  return { greatCircles, smallCircles };
}
function cardinalPoints(radius, cx, cy, offset) {
  return [
    { label: "N", x: cx, y: cy - radius - offset },
    { label: "E", x: cx + radius + offset, y: cy },
    { label: "S", x: cx, y: cy + radius + offset },
    { label: "W", x: cx - radius - offset, y: cy }
  ];
}

// src/render/svg.js
function attr(obj) {
  return Object.entries(obj).filter(([, v]) => v !== void 0 && v !== null).map(([k, v]) => `${k}="${v}"`).join(" ");
}
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
var SvgBuilder = class {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.elements = [];
  }
  circle(cx, cy, r, style = {}) {
    this.elements.push(`<circle ${attr({ cx, cy, r, ...style })}/>`);
    return this;
  }
  line(x1, y1, x2, y2, style = {}) {
    this.elements.push(`<line ${attr({ x1, y1, x2, y2, ...style })}/>`);
    return this;
  }
  polyline(points, style = {}) {
    const pts = points.map(([x, y]) => `${x},${y}`).join(" ");
    this.elements.push(`<polyline ${attr({ points: pts, fill: "none", ...style })}/>`);
    return this;
  }
  path(d, style = {}) {
    this.elements.push(`<path ${attr({ d, ...style })}/>`);
    return this;
  }
  text(x, y, content, style = {}) {
    const { "text-anchor": anchor, ...rest } = style;
    const anchorAttr = anchor ? ` text-anchor="${anchor}"` : "";
    this.elements.push(`<text ${attr({ x, y, ...rest })}${anchorAttr}>${esc(content)}</text>`);
    return this;
  }
  group(id, children) {
    const idAttr = id ? ` id="${id}"` : "";
    this.elements.push(`<g${idAttr}>${children}</g>`);
    return this;
  }
  /**
   * Add a clipping circle definition and return a group opener string.
   */
  clipCircle(id, cx, cy, r) {
    this.elements.push(
      `<defs><clipPath id="${id}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath></defs>`
    );
    return this;
  }
  openClipGroup(clipId) {
    this.elements.push(`<g clip-path="url(#${clipId})">`);
    return this;
  }
  closeGroup() {
    this.elements.push("</g>");
    return this;
  }
  toString() {
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}">`,
      ...this.elements,
      "</svg>"
    ].join("\n");
  }
  /**
   * Parse SVG string into a DOM element (browser only).
   */
  toElement() {
    const parser = new DOMParser();
    const doc = parser.parseFromString(this.toString(), "image/svg+xml");
    return doc.documentElement;
  }
};

// src/render/style.js
function deepMerge(target, ...sources) {
  const result = { ...target };
  for (const source of sources) {
    if (!source) continue;
    for (const key of Object.keys(source)) {
      if (source[key] === void 0) continue;
      if (source[key] !== null && typeof source[key] === "object" && !Array.isArray(source[key]) && result[key] !== null && typeof result[key] === "object" && !Array.isArray(result[key])) {
        result[key] = deepMerge(result[key], source[key]);
      } else {
        result[key] = source[key];
      }
    }
  }
  return result;
}
function resolveStyle(category, instanceStyle, itemStyle) {
  const base = defaults[category];
  if (typeof base === "object" && base !== null) {
    const result = { ...base };
    const inst2 = instanceStyle?.[category];
    if (inst2 && typeof inst2 === "object") {
      for (const [k, v] of Object.entries(inst2)) {
        if (v !== void 0) result[k] = v;
      }
    }
    if (itemStyle && typeof itemStyle === "object") {
      for (const [k, v] of Object.entries(itemStyle)) {
        if (v !== void 0) result[k] = v;
      }
    }
    return result;
  }
  if (itemStyle !== void 0) return itemStyle;
  const inst = instanceStyle?.[category];
  if (inst !== void 0) return inst;
  return base;
}
var defaults = {
  size: 500,
  padding: 30,
  background: "#ffffff",
  primitive: {
    stroke: "#000000",
    strokeWidth: 1.5,
    fill: "none"
  },
  grid: {
    stroke: "#cccccc",
    strokeWidth: 0.5,
    majorStroke: "#999999",
    majorStrokeWidth: 0.75
  },
  cardinals: {
    fontSize: 14,
    fontFamily: "sans-serif",
    fill: "#000000",
    offset: 16
  },
  pole: {
    r: 3,
    fill: "#000000",
    stroke: "none"
  },
  line: {
    r: 4,
    fill: "#000000",
    stroke: "none"
  },
  plane: {
    stroke: "#000000",
    strokeWidth: 1.2,
    fill: "none"
  },
  cone: {
    stroke: "#000000",
    strokeWidth: 1,
    fill: "none",
    strokeDasharray: "4,3"
  }
};

// src/contouring.js
var DEG2 = Math.PI / 180;
function computeContours(dcos, options = {}) {
  const {
    projection = "equal-area",
    rotation = null,
    gridSize = 40,
    levels = [2, 4, 6, 8]
  } = options;
  const n = dcos.length;
  if (n === 0) return levels.map((level) => ({ level, paths: [] }));
  const sigma = (options.sigma != null ? options.sigma : 90 / Math.sqrt(n)) * DEG2;
  const cosSigma = Math.cos(sigma);
  const kappa = 1 / (1 - cosSigma);
  const inverseFn = projection === "equal-angle" ? inverse2 : inverse;
  const projR = projection === "equal-angle" ? 1 : Math.SQRT2;
  const data = rotation ? dcos.map((d) => transformVec3(rotation, d)) : dcos;
  const grid = new Float64Array(gridSize * gridSize);
  const step = 2 * projR / (gridSize - 1);
  for (let j = 0; j < gridSize; j++) {
    const py = projR - j * step;
    for (let i = 0; i < gridSize; i++) {
      const px = -projR + i * step;
      if (px * px + py * py > projR * projR * 1.02) {
        grid[j * gridSize + i] = NaN;
        continue;
      }
      const d = inverseFn(px, py);
      if (!d) {
        grid[j * gridSize + i] = NaN;
        continue;
      }
      let density = 0;
      for (let k = 0; k < n; k++) {
        const rd = data[k];
        const dot2 = d[0] * rd[0] + d[1] * rd[1] + d[2] * rd[2];
        density += Math.exp(kappa * (dot2 - 1));
      }
      grid[j * gridSize + i] = kappa * density / n;
    }
  }
  return levels.map((level) => ({
    level,
    paths: assembleSegments(
      marchingSquares(grid, gridSize, step, projR, level)
    )
  }));
}
function marchingSquares(grid, size, step, projR, level) {
  const segments = [];
  for (let j = 0; j < size - 1; j++) {
    for (let i = 0; i < size - 1; i++) {
      const vTL = grid[j * size + i];
      const vTR = grid[j * size + i + 1];
      const vBL = grid[(j + 1) * size + i];
      const vBR = grid[(j + 1) * size + i + 1];
      if (isNaN(vTL) || isNaN(vTR) || isNaN(vBL) || isNaN(vBR)) continue;
      const code = (vTL >= level ? 8 : 0) | (vTR >= level ? 4 : 0) | (vBR >= level ? 2 : 0) | (vBL >= level ? 1 : 0);
      if (code === 0 || code === 15) continue;
      const x0 = -projR + i * step;
      const x1 = x0 + step;
      const y0 = projR - j * step;
      const y1 = y0 - step;
      const lerp = (va, vb, pa, pb) => pa + (level - va) / (vb - va) * (pb - pa);
      const T = [lerp(vTL, vTR, x0, x1), y0];
      const B = [lerp(vBL, vBR, x0, x1), y1];
      const L = [x0, lerp(vTL, vBL, y0, y1)];
      const R = [x1, lerp(vTR, vBR, y0, y1)];
      switch (code) {
        case 1:
        case 14:
          segments.push([B, L]);
          break;
        case 2:
        case 13:
          segments.push([R, B]);
          break;
        case 3:
        case 12:
          segments.push([R, L]);
          break;
        case 4:
        case 11:
          segments.push([T, R]);
          break;
        case 6:
        case 9:
          segments.push([T, B]);
          break;
        case 7:
        case 8:
          segments.push([T, L]);
          break;
        case 5: {
          const ctr = (vTL + vTR + vBL + vBR) / 4;
          if (ctr >= level) {
            segments.push([L, T]);
            segments.push([B, R]);
          } else {
            segments.push([B, L]);
            segments.push([T, R]);
          }
          break;
        }
        case 10: {
          const ctr = (vTL + vTR + vBL + vBR) / 4;
          if (ctr >= level) {
            segments.push([T, R]);
            segments.push([L, B]);
          } else {
            segments.push([T, L]);
            segments.push([R, B]);
          }
          break;
        }
      }
    }
  }
  return segments;
}
var SNAP = 1e-8;
function close(a, b) {
  return Math.abs(a[0] - b[0]) < SNAP && Math.abs(a[1] - b[1]) < SNAP;
}
function assembleSegments(segments) {
  if (segments.length === 0) return [];
  const used = new Uint8Array(segments.length);
  const paths = [];
  for (let s = 0; s < segments.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const path = [segments[s][0], segments[s][1]];
    let changed = true;
    while (changed) {
      changed = false;
      const tail = path[path.length - 1];
      for (let i = 0; i < segments.length; i++) {
        if (used[i]) continue;
        if (close(tail, segments[i][0])) {
          path.push(segments[i][1]);
          used[i] = 1;
          changed = true;
          break;
        }
        if (close(tail, segments[i][1])) {
          path.push(segments[i][0]);
          used[i] = 1;
          changed = true;
          break;
        }
      }
    }
    changed = true;
    while (changed) {
      changed = false;
      const head = path[0];
      for (let i = 0; i < segments.length; i++) {
        if (used[i]) continue;
        if (close(head, segments[i][1])) {
          path.unshift(segments[i][0]);
          used[i] = 1;
          changed = true;
          break;
        }
        if (close(head, segments[i][0])) {
          path.unshift(segments[i][1]);
          used[i] = 1;
          changed = true;
          break;
        }
      }
    }
    paths.push(path);
  }
  return paths;
}

// src/stereonet.js
var DEG3 = Math.PI / 180;
var SVG_NS = "http://www.w3.org/2000/svg";
var nextClipId = 0;
function equatorCrossing(a, b) {
  const t = a[2] / (a[2] - b[2]);
  const x = a[0] + t * (b[0] - a[0]);
  const y = a[1] + t * (b[1] - a[1]);
  const len = Math.sqrt(x * x + y * y);
  return len > 1e-10 ? [x / len, y / len, 0] : [x, y, 0];
}
function clipToLowerHemisphere(points) {
  const segments = [];
  let current = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p[2] <= 0) {
      if (current.length === 0 && i > 0 && points[i - 1][2] > 0) {
        current.push(equatorCrossing(points[i - 1], p));
      }
      current.push(p);
    } else {
      if (current.length > 0) {
        current.push(equatorCrossing(points[i - 1], p));
        segments.push(current);
        current = [];
      }
    }
  }
  if (current.length > 0) {
    segments.push(current);
  }
  return segments;
}
function segmentsToPathD(segments) {
  const parts = [];
  for (const seg of segments) {
    if (seg.length > 1) {
      parts.push("M" + seg.map(([x, y]) => `${x},${y}`).join("L"));
    }
  }
  return parts.join("");
}
var Stereonet = class _Stereonet {
  constructor(options = {}) {
    this.size = options.size || defaults.size;
    this.padding = options.padding ?? defaults.padding;
    this.projection = options.projection || "equal-area";
    this.net = options.net || "equatorial";
    this.rotation = options.rotation ?? (options.center ? _Stereonet.rotationFromCenter(options.center[0], options.center[1]) : options.northPole ? _Stereonet.rotationFromNorthPole(options.northPole[0], options.northPole[1], options.northPole[2] || 0) : null);
    this._instanceStyle = options.style || null;
    this._classPrefix = options.classPrefix !== void 0 ? options.classPrefix : "bearing";
    this._items = [];
    this._clipId = `bearing-clip-${nextClipId++}`;
    this._contourDcos = null;
    this._contourOptions = null;
    this._contourPaths = null;
    this._el = null;
    this._bgEl = null;
    this._gcPath = null;
    this._scPath = null;
    this._contourGroup = null;
    this._dataGroup = null;
    this._primEl = null;
    this._cardinalEls = null;
  }
  /**
   * Build a rotation matrix that maps direction (trend, plunge) to the
   * center of the stereonet [0, 0, -1].
   * @param {number} trend - trend in degrees
   * @param {number} plunge - plunge in degrees
   * @returns {Array<number>} 3x3 rotation matrix (flat row-major)
   */
  static rotationFromCenter(trend, plunge) {
    const d = lineToDcos(trend, plunge);
    const target = [0, 0, -1];
    const axis = cross(d, target);
    const len = length(axis);
    if (len < 1e-10) {
      return dot(d, target) > 0 ? identity() : rotationFromAxisAngle([1, 0, 0], Math.PI);
    }
    const theta = angle(d, target);
    return rotationFromAxisAngle(normalize(axis), theta);
  }
  /**
   * Build a rotation matrix from north pole placement + spin.
   * (trend, plunge) specifies where geographic North [0,1,0] ends up;
   * spin is an additional rotation around the North axis before tilting.
   * @param {number} trend - trend of new North position in degrees
   * @param {number} plunge - plunge of new North position in degrees
   * @param {number} [spin=0] - rotation about the North axis in degrees
   * @returns {Array<number>} 3x3 rotation matrix (flat row-major)
   */
  static rotationFromNorthPole(trend, plunge, spin = 0) {
    const north = [0, 1, 0];
    const target = lineToDcos(trend, plunge);
    const Rspin = rotationFromAxisAngle(north, spin * DEG3);
    const axis = cross(north, target);
    const len = length(axis);
    let Rtilt;
    if (len < 1e-10) {
      Rtilt = dot(north, target) > 0 ? identity() : rotationFromAxisAngle([1, 0, 0], Math.PI);
    } else {
      const theta = angle(north, target);
      Rtilt = rotationFromAxisAngle(normalize(axis), theta);
    }
    return multiply(Rtilt, Rspin);
  }
  get _projectFn() {
    return this.projection === "equal-angle" ? project2 : project;
  }
  /** Primitive circle radius in SVG coordinates. */
  get _radius() {
    return (this.size - 2 * this.padding) / 2;
  }
  get _center() {
    return this.size / 2;
  }
  /**
   * Scale factor: maps projection output (radius √2 for equal-area, 1 for equal-angle)
   * to SVG pixel coordinates.
   */
  get _scale() {
    const projRadius = this.projection === "equal-angle" ? 1 : Math.SQRT2;
    return this._radius / projRadius;
  }
  /** Convert projected [px, py] to SVG [x, y]. */
  _toSvg(px, py) {
    const c = this._center;
    const s = this._scale;
    return [c + px * s, c - py * s];
  }
  /** Resolve style for a category using the three-level cascade. */
  _resolveCategory(category, itemStyle) {
    return resolveStyle(category, this._instanceStyle, itemStyle);
  }
  /** Build CSS class string for an SVG element. Returns undefined if classes disabled. */
  _classFor(suffix, extraClass) {
    if (this._classPrefix === null) return void 0;
    const base = `${this._classPrefix}-${suffix}`;
    return extraClass ? `${base} ${extraClass}` : base;
  }
  /**
   * Update the instance-level style at runtime. Call render() to apply.
   * @param {Object} style - instance style overrides
   * @returns {this}
   */
  setStyle(style) {
    this._instanceStyle = style;
    return this;
  }
  /** Rotate a 3D point by the stereonet's rotation matrix. */
  _rotate(p) {
    return this.rotation ? transformVec3(this.rotation, p) : p;
  }
  /**
   * Process a 3D curve: rotate, clip to lower hemisphere, project to SVG.
   * Returns array of SVG polyline coordinate arrays (one per visible segment).
   */
  _projectCurve(points3d) {
    const rotated = this.rotation ? points3d.map((p) => transformVec3(this.rotation, p)) : points3d;
    const segments = clipToLowerHemisphere(rotated);
    return segments.map(
      (seg) => seg.map((p) => {
        const [px, py] = this._projectFn(p);
        return this._toSvg(px, py);
      })
    );
  }
  // ---------------------------------------------------------------------------
  //  Data methods — push items, return `this` for chaining
  // ---------------------------------------------------------------------------
  /** Read-only access to the items array. */
  get items() {
    return this._items;
  }
  /**
   * Plot pole to a plane. dd = dip direction, dip = dip angle (degrees).
   */
  pole(dd, dip, style = {}) {
    this._items.push({ type: "pole", dd, dip, style, _el: null });
    return this;
  }
  /**
   * Plot a line (trend/plunge). trend and plunge in degrees.
   */
  line(trend, plunge, style = {}) {
    this._items.push({ type: "line", trend, plunge, style, _el: null });
    return this;
  }
  /**
   * Plot a great circle for a plane. dd = dip direction, dip = dip angle.
   */
  plane(dd, dip, style = {}) {
    this._items.push({ type: "plane", dd, dip, style, _el: null });
    return this;
  }
  /**
   * Plot a small circle (cone). trend/plunge in degrees, halfAngle in degrees.
   */
  cone(trend, plunge, halfAngle, style = {}) {
    this._items.push({ type: "cone", trend, plunge, halfAngle, style, _el: null });
    return this;
  }
  /**
   * Add density contour lines for a set of direction cosines.
   * @param {Array<number[]>} dcos - unit vectors (lower hemisphere)
   * @param {Object} [options]
   * @param {number[]} [options.levels=[2,4,6,8]] - MUD levels
   * @param {number}  [options.sigma] - kernel half-width degrees (auto if omitted)
   * @param {number}  [options.gridSize=40] - grid resolution
   * @param {string}  [options.stroke='#333'] - line colour
   * @param {number}  [options.strokeWidth=0.8]
   * @param {string[]} [options.colors] - per-level stroke colours (overrides stroke)
   * @returns {this}
   */
  contour(dcos, options = {}) {
    this._contourDcos = dcos;
    this._contourOptions = options;
    this._computeContours();
    return this;
  }
  /** Recompute contours (call after rotation changes if contours are active). */
  updateContours() {
    this._computeContours();
    return this;
  }
  /** Remove contour data. Returns `this`. */
  clearContours() {
    this._contourDcos = null;
    this._contourOptions = null;
    this._contourPaths = null;
    if (this._contourGroup) {
      while (this._contourGroup.firstChild) this._contourGroup.firstChild.remove();
    }
    return this;
  }
  _computeContours() {
    if (!this._contourDcos || this._contourDcos.length === 0) {
      this._contourPaths = null;
      return;
    }
    this._contourPaths = computeContours(this._contourDcos, {
      projection: this.projection,
      rotation: this.rotation,
      ...this._contourOptions
    });
  }
  /** Remove all data items. Returns `this`. */
  clear() {
    for (const item of this._items) {
      if (item._el) item._el.remove();
    }
    this._items.length = 0;
    return this;
  }
  /** Remove a specific item (by reference from .items). Returns `this`. */
  remove(item) {
    const idx = this._items.indexOf(item);
    if (idx >= 0) {
      if (item._el) item._el.remove();
      this._items.splice(idx, 1);
    }
    return this;
  }
  // ---------------------------------------------------------------------------
  //  View control
  // ---------------------------------------------------------------------------
  /** Set rotation matrix. Call render() to apply. Returns `this`. */
  setRotation(rotation) {
    this.rotation = rotation;
    return this;
  }
  /** Set rotation by center direction. Call render() to apply. Returns `this`. */
  setCenter(trend, plunge) {
    this.rotation = _Stereonet.rotationFromCenter(trend, plunge);
    return this;
  }
  /** Set rotation by north pole placement + spin. Call render() to apply. Returns `this`. */
  setNorthPole(trend, plunge, spin = 0) {
    this.rotation = _Stereonet.rotationFromNorthPole(trend, plunge, spin);
    return this;
  }
  // ---------------------------------------------------------------------------
  //  Static SVG string output (works in Node, no DOM)
  // ---------------------------------------------------------------------------
  /**
   * Build and return the SVG as a string.
   */
  svg() {
    const svg = new SvgBuilder(this.size, this.size);
    const c = this._center;
    const r = this._radius;
    svg.circle(c, c, r, {
      fill: this._resolveCategory("background"),
      stroke: "none",
      class: this._classFor("background")
    });
    svg.clipCircle(this._clipId, c, c, r);
    svg.openClipGroup(this._clipId);
    const gridStyle = this._resolveCategory("grid");
    const { greatCircles, smallCircles } = generateNet(10, this.net);
    for (const gc of greatCircles) {
      for (const seg of this._projectCurve(gc)) {
        if (seg.length > 1) {
          svg.polyline(seg, {
            stroke: gridStyle.stroke,
            "stroke-width": gridStyle.strokeWidth,
            class: this._classFor("grid")
          });
        }
      }
    }
    for (const sc of smallCircles) {
      for (const seg of this._projectCurve(sc)) {
        if (seg.length > 1) {
          svg.polyline(seg, {
            stroke: gridStyle.stroke,
            "stroke-width": gridStyle.strokeWidth,
            class: this._classFor("grid")
          });
        }
      }
    }
    if (this._contourPaths) {
      this._renderContoursString(svg);
    }
    for (const item of this._items) {
      this._renderItemString(svg, item);
    }
    svg.closeGroup();
    const primStyle = this._resolveCategory("primitive");
    svg.circle(c, c, r, {
      fill: "none",
      stroke: primStyle.stroke,
      "stroke-width": primStyle.strokeWidth,
      class: this._classFor("primitive")
    });
    this._renderCardinalsString(svg, c, r);
    return svg.toString();
  }
  _renderCardinalsString(svg, cx, r) {
    const cardStyle = this._resolveCategory("cardinals");
    const offset = cardStyle.offset;
    const style = {
      "font-size": cardStyle.fontSize,
      "font-family": cardStyle.fontFamily,
      fill: cardStyle.fill,
      "text-anchor": "middle",
      "dominant-baseline": "central",
      class: this._classFor("cardinal")
    };
    const directions = [
      { label: "N", dcos: [0, 1, 0] },
      { label: "E", dcos: [1, 0, 0] },
      { label: "S", dcos: [0, -1, 0] },
      { label: "W", dcos: [-1, 0, 0] }
    ];
    for (const { label, dcos } of directions) {
      const d = this._rotate(dcos);
      const hLen = Math.sqrt(d[0] * d[0] + d[1] * d[1]);
      if (hLen < 0.05) continue;
      svg.text(
        cx + (r + offset) * d[0] / hLen,
        cx - (r + offset) * d[1] / hLen,
        label,
        style
      );
    }
  }
  _renderContoursString(svg) {
    const opts = this._contourOptions || {};
    const defaultStroke = opts.stroke || "#333";
    const defaultWidth = opts.strokeWidth || 0.8;
    const colors = opts.colors;
    const cls = this._classFor("contour");
    for (let k = 0; k < this._contourPaths.length; k++) {
      const { paths } = this._contourPaths[k];
      const stroke = colors && colors[k] ? colors[k] : defaultStroke;
      for (const path of paths) {
        const svgPts = path.map(([px, py]) => this._toSvg(px, py));
        if (svgPts.length > 1) {
          svg.polyline(svgPts, {
            stroke,
            "stroke-width": defaultWidth,
            fill: "none",
            class: cls
          });
        }
      }
    }
  }
  _renderItemString(svg, item) {
    switch (item.type) {
      case "pole": {
        const dcos = planeToDcos(item.dd, item.dip);
        const d = this._rotate(dcos);
        const [px, py] = this._projectFn(d);
        const [sx, sy] = this._toSvg(px, py);
        const s = this._resolveCategory("pole", item.style);
        svg.circle(sx, sy, s.r, {
          fill: s.fill,
          stroke: s.stroke,
          class: this._classFor("pole", item.style.class)
        });
        break;
      }
      case "line": {
        const dcos = lineToDcos(item.trend, item.plunge);
        const d = this._rotate(dcos);
        const [px, py] = this._projectFn(d);
        const [sx, sy] = this._toSvg(px, py);
        const s = this._resolveCategory("line", item.style);
        svg.circle(sx, sy, s.r, {
          fill: s.fill,
          stroke: s.stroke,
          class: this._classFor("line", item.style.class)
        });
        break;
      }
      case "plane": {
        const pole = planeToDcos(item.dd, item.dip);
        const pts3d = greatCircle(pole, 180);
        const s = this._resolveCategory("plane", item.style);
        for (const seg of this._projectCurve(pts3d)) {
          if (seg.length > 1) {
            svg.polyline(seg, {
              stroke: s.stroke,
              "stroke-width": s.strokeWidth,
              fill: "none",
              class: this._classFor("plane", item.style.class)
            });
          }
        }
        break;
      }
      case "cone": {
        const axis = lineToDcos(item.trend, item.plunge);
        const halfAngle = item.halfAngle * DEG3;
        const pts3d = smallCircle(axis, halfAngle, 180);
        const s = this._resolveCategory("cone", item.style);
        for (const seg of this._projectCurve(pts3d)) {
          if (seg.length > 1) {
            svg.polyline(seg, {
              stroke: s.stroke,
              "stroke-width": s.strokeWidth,
              fill: "none",
              "stroke-dasharray": s.strokeDasharray,
              class: this._classFor("cone", item.style.class)
            });
          }
        }
        break;
      }
    }
  }
  // ---------------------------------------------------------------------------
  //  DOM rendering — persistent SVG element, in-place attribute updates
  // ---------------------------------------------------------------------------
  /**
   * Return the persistent SVG DOM element (browser only).
   * Creates and renders on first call; subsequent calls return the same element.
   * Call render() after changing data or rotation to update.
   */
  element() {
    if (!this._el) {
      this._buildDOM();
      this.render();
    }
    return this._el;
  }
  /** Build the persistent SVG DOM structure. */
  _buildDOM() {
    const s = this.size;
    const c = this._center;
    const r = this._radius;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("xmlns", SVG_NS);
    svg.setAttribute("width", s);
    svg.setAttribute("height", s);
    svg.setAttribute("viewBox", `0 0 ${s} ${s}`);
    this._bgEl = document.createElementNS(SVG_NS, "circle");
    setAttrs(this._bgEl, {
      cx: c,
      cy: c,
      r,
      fill: this._resolveCategory("background"),
      stroke: "none",
      class: this._classFor("background")
    });
    svg.appendChild(this._bgEl);
    const defs = document.createElementNS(SVG_NS, "defs");
    const clipPath = document.createElementNS(SVG_NS, "clipPath");
    clipPath.setAttribute("id", this._clipId);
    const clipCircle = document.createElementNS(SVG_NS, "circle");
    setAttrs(clipCircle, { cx: c, cy: c, r });
    clipPath.appendChild(clipCircle);
    defs.appendChild(clipPath);
    svg.appendChild(defs);
    const clipGroup = document.createElementNS(SVG_NS, "g");
    clipGroup.setAttribute("clip-path", `url(#${this._clipId})`);
    const gridStyle = this._resolveCategory("grid");
    this._gcPath = document.createElementNS(SVG_NS, "path");
    setAttrs(this._gcPath, {
      stroke: gridStyle.stroke,
      "stroke-width": gridStyle.strokeWidth,
      fill: "none",
      class: this._classFor("grid")
    });
    clipGroup.appendChild(this._gcPath);
    this._scPath = document.createElementNS(SVG_NS, "path");
    setAttrs(this._scPath, {
      stroke: gridStyle.stroke,
      "stroke-width": gridStyle.strokeWidth,
      fill: "none",
      class: this._classFor("grid")
    });
    clipGroup.appendChild(this._scPath);
    this._contourGroup = document.createElementNS(SVG_NS, "g");
    clipGroup.appendChild(this._contourGroup);
    this._dataGroup = document.createElementNS(SVG_NS, "g");
    clipGroup.appendChild(this._dataGroup);
    svg.appendChild(clipGroup);
    const primStyle = this._resolveCategory("primitive");
    this._primEl = document.createElementNS(SVG_NS, "circle");
    setAttrs(this._primEl, {
      cx: c,
      cy: c,
      r,
      fill: "none",
      stroke: primStyle.stroke,
      "stroke-width": primStyle.strokeWidth,
      class: this._classFor("primitive")
    });
    svg.appendChild(this._primEl);
    const cardStyle = this._resolveCategory("cardinals");
    this._cardinalEls = [];
    for (const label of ["N", "E", "S", "W"]) {
      const text = document.createElementNS(SVG_NS, "text");
      setAttrs(text, {
        "font-size": cardStyle.fontSize,
        "font-family": cardStyle.fontFamily,
        fill: cardStyle.fill,
        "text-anchor": "middle",
        "dominant-baseline": "central",
        class: this._classFor("cardinal")
      });
      text.textContent = label;
      svg.appendChild(text);
      this._cardinalEls.push(text);
    }
    this._el = svg;
  }
  /**
   * Update the persistent DOM element in place.
   * No-op if element() hasn't been called yet.
   * Returns `this`.
   */
  render() {
    if (!this._el) return this;
    const gridStyle = this._resolveCategory("grid");
    const primStyle = this._resolveCategory("primitive");
    this._bgEl.setAttribute("fill", this._resolveCategory("background"));
    setAttrs(this._gcPath, { stroke: gridStyle.stroke, "stroke-width": gridStyle.strokeWidth });
    setAttrs(this._scPath, { stroke: gridStyle.stroke, "stroke-width": gridStyle.strokeWidth });
    setAttrs(this._primEl, { stroke: primStyle.stroke, "stroke-width": primStyle.strokeWidth });
    const { greatCircles, smallCircles } = generateNet(10, this.net);
    this._gcPath.setAttribute("d", this._curvesToPathD(greatCircles));
    this._scPath.setAttribute("d", this._curvesToPathD(smallCircles));
    this._renderContoursDOM();
    for (const item of this._items) {
      this._renderItemDOM(item);
    }
    this._renderCardinalsDOM();
    return this;
  }
  /** Convert an array of 3D curves to a combined SVG path d string. */
  _curvesToPathD(curves3d) {
    const parts = [];
    for (const curve of curves3d) {
      for (const seg of this._projectCurve(curve)) {
        if (seg.length > 1) {
          parts.push("M" + seg.map(([x, y]) => `${x},${y}`).join("L"));
        }
      }
    }
    return parts.join("");
  }
  /** Create or update the DOM element for a data item. */
  _renderItemDOM(item) {
    switch (item.type) {
      case "pole": {
        const dcos = planeToDcos(item.dd, item.dip);
        const d = this._rotate(dcos);
        const [px, py] = this._projectFn(d);
        const [sx, sy] = this._toSvg(px, py);
        const s = this._resolveCategory("pole", item.style);
        if (!item._el) {
          item._el = document.createElementNS(SVG_NS, "circle");
          setAttrs(item._el, { class: this._classFor("pole", item.style.class) });
          this._dataGroup.appendChild(item._el);
        }
        setAttrs(item._el, {
          cx: sx,
          cy: sy,
          r: s.r,
          fill: s.fill,
          stroke: s.stroke
        });
        break;
      }
      case "line": {
        const dcos = lineToDcos(item.trend, item.plunge);
        const d = this._rotate(dcos);
        const [px, py] = this._projectFn(d);
        const [sx, sy] = this._toSvg(px, py);
        const s = this._resolveCategory("line", item.style);
        if (!item._el) {
          item._el = document.createElementNS(SVG_NS, "circle");
          setAttrs(item._el, { class: this._classFor("line", item.style.class) });
          this._dataGroup.appendChild(item._el);
        }
        setAttrs(item._el, {
          cx: sx,
          cy: sy,
          r: s.r,
          fill: s.fill,
          stroke: s.stroke
        });
        break;
      }
      case "plane": {
        const pole = planeToDcos(item.dd, item.dip);
        const pts3d = greatCircle(pole, 180);
        const d = segmentsToPathD(this._projectCurve(pts3d));
        const s = this._resolveCategory("plane", item.style);
        if (!item._el) {
          item._el = document.createElementNS(SVG_NS, "path");
          setAttrs(item._el, { class: this._classFor("plane", item.style.class) });
          this._dataGroup.appendChild(item._el);
        }
        setAttrs(item._el, {
          d,
          stroke: s.stroke,
          "stroke-width": s.strokeWidth,
          fill: "none"
        });
        break;
      }
      case "cone": {
        const axis = lineToDcos(item.trend, item.plunge);
        const halfAngle = item.halfAngle * DEG3;
        const pts3d = smallCircle(axis, halfAngle, 180);
        const d = segmentsToPathD(this._projectCurve(pts3d));
        const s = this._resolveCategory("cone", item.style);
        if (!item._el) {
          item._el = document.createElementNS(SVG_NS, "path");
          setAttrs(item._el, { class: this._classFor("cone", item.style.class) });
          this._dataGroup.appendChild(item._el);
        }
        setAttrs(item._el, {
          d,
          stroke: s.stroke,
          "stroke-width": s.strokeWidth,
          fill: "none",
          "stroke-dasharray": s.strokeDasharray
        });
        break;
      }
    }
  }
  /** Update contour paths in the DOM. */
  _renderContoursDOM() {
    if (!this._contourGroup) return;
    while (this._contourGroup.firstChild) this._contourGroup.firstChild.remove();
    if (!this._contourPaths) return;
    const opts = this._contourOptions || {};
    const defaultStroke = opts.stroke || "#333";
    const defaultWidth = opts.strokeWidth || 0.8;
    const colors = opts.colors;
    const cls = this._classFor("contour");
    for (let k = 0; k < this._contourPaths.length; k++) {
      const { paths } = this._contourPaths[k];
      const stroke = colors && colors[k] ? colors[k] : defaultStroke;
      for (const path of paths) {
        const svgPts = path.map(([px, py]) => this._toSvg(px, py));
        if (svgPts.length > 1) {
          const d = "M" + svgPts.map(([x, y]) => `${x},${y}`).join("L");
          const el = document.createElementNS(SVG_NS, "path");
          setAttrs(el, { d, stroke, "stroke-width": defaultWidth, fill: "none", class: cls });
          this._contourGroup.appendChild(el);
        }
      }
    }
  }
  /**
   * Return the SVG as a data: URI suitable for an <img> src or download.
   * @returns {string} data:image/svg+xml;... URI
   */
  svgDataURL() {
    const svgStr = this.svg();
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgStr);
  }
  /**
   * Trigger a browser download of the SVG (browser-only).
   * @param {string} [filename='stereonet.svg']
   */
  download(filename = "stereonet.svg") {
    const url = this.svgDataURL();
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
  /** Update cardinal label positions in the DOM. */
  _renderCardinalsDOM() {
    const cx = this._center;
    const r = this._radius;
    const cardStyle = this._resolveCategory("cardinals");
    const offset = cardStyle.offset;
    const directions = [[0, 1, 0], [1, 0, 0], [0, -1, 0], [-1, 0, 0]];
    for (let i = 0; i < 4; i++) {
      const d = this._rotate(directions[i]);
      const hLen = Math.sqrt(d[0] * d[0] + d[1] * d[1]);
      const el = this._cardinalEls[i];
      if (hLen < 0.05) {
        el.setAttribute("display", "none");
      } else {
        el.removeAttribute("display");
        el.setAttribute("x", cx + (r + offset) * d[0] / hLen);
        el.setAttribute("y", cx - (r + offset) * d[1] / hLen);
        el.setAttribute("font-size", cardStyle.fontSize);
        el.setAttribute("font-family", cardStyle.fontFamily);
        el.setAttribute("fill", cardStyle.fill);
      }
    }
  }
};
function setAttrs(el, attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== void 0 && v !== null) el.setAttribute(k, v);
  }
}

// src/io.js
var io_exports = {};
__export(io_exports, {
  parse: () => parse,
  parseDip: () => parseDip,
  parseDirection: () => parseDirection,
  parseLines: () => parseLines,
  parsePlanes: () => parsePlanes,
  translateAttitude: () => translateAttitude
});
function parseDirection(s) {
  s = s.trim().toUpperCase();
  if (/^-?\d+(\.\d+)?$/.test(s)) return (parseFloat(s) % 360 + 360) % 360;
  const m = s.match(/^([NS])(\d+(?:\.\d+)?)([EW])?$/);
  if (!m) throw new Error(`Cannot parse direction: "${s}"`);
  const from = m[1];
  const angle2 = parseFloat(m[2]);
  const to = m[3] || "";
  if (from === "N") {
    if (to === "E" || to === "") return angle2;
    if (to === "W") return (360 - angle2) % 360;
  }
  if (from === "S") {
    if (to === "E") return 180 - angle2;
    if (to === "W") return 180 + angle2;
    return 180 - angle2;
  }
  throw new Error(`Cannot parse direction: "${s}"`);
}
function parseDip(s) {
  s = s.trim().toUpperCase();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([NESW]{0,2})$/);
  if (!m) throw new Error(`Cannot parse dip: "${s}"`);
  return { dip: parseFloat(m[1]), quadrant: m[2] || "" };
}
function quadrantToAzimuth(q) {
  const map = {
    N: 0,
    NE: 45,
    E: 90,
    SE: 135,
    S: 180,
    SW: 225,
    W: 270,
    NW: 315
  };
  if (!(q in map)) throw new Error(`Unknown dip quadrant: "${q}"`);
  return map[q];
}
function translateAttitude(direction, dip, quadrant, strike = false) {
  if (!strike) {
    return [(direction % 360 + 360) % 360, dip];
  }
  if (!quadrant) {
    return [((direction + 90) % 360 + 360) % 360, dip];
  }
  const qAz = quadrantToAzimuth(quadrant);
  const dd1 = ((direction + 90) % 360 + 360) % 360;
  const dd2 = ((direction - 90) % 360 + 360) % 360;
  const diff1 = Math.abs(angleDiff(dd1, qAz));
  const diff2 = Math.abs(angleDiff(dd2, qAz));
  return [diff1 <= diff2 ? dd1 : dd2, dip];
}
function angleDiff(a, b) {
  let d = ((b - a) % 360 + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}
function parse(text) {
  const results = [];
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/[\/,\s\t]+/).filter(Boolean);
    if (parts.length < 2) continue;
    const a = parseFloat(parts[0]);
    const b = parseFloat(parts[1]);
    if (isNaN(a) || isNaN(b)) continue;
    results.push([a, b]);
  }
  return results;
}
function parsePlanes(text, options = {}) {
  const strike = !!options.strike;
  const results = [];
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/[\/,\s\t]+/).filter(Boolean);
    if (parts.length < 2) continue;
    let direction, dipVal, quadrant;
    try {
      direction = parseDirection(parts[0]);
      const parsed = parseDip(parts[1]);
      dipVal = parsed.dip;
      quadrant = parsed.quadrant;
    } catch {
      continue;
    }
    const [dd, dip] = translateAttitude(direction, dipVal, quadrant, strike);
    results.push(planeToDcos(dd, dip));
  }
  return results;
}
function parseLines(text) {
  const results = [];
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/[\/,\s\t]+/).filter(Boolean);
    if (parts.length < 2) continue;
    const trend = parseFloat(parts[0]);
    const plunge = parseFloat(parts[1]);
    if (isNaN(trend) || isNaN(plunge)) continue;
    results.push(lineToDcos(trend, plunge));
  }
  return results;
}

// src/statistics.js
var statistics_exports = {};
__export(statistics_exports, {
  fisherStats: () => fisherStats,
  meanVector: () => meanVector,
  orientationTensor: () => orientationTensor,
  principalAxes: () => principalAxes,
  resultant: () => resultant
});

// src/core/eigen.js
var TWO_PI_OVER_3 = 2 * Math.PI / 3;
function symmetricEigen3(m) {
  const a00 = m[0], a01 = m[1], a02 = m[2];
  const a11 = m[4], a12 = m[5];
  const a22 = m[8];
  const p1 = a01 * a01 + a02 * a02 + a12 * a12;
  if (p1 < 1e-30) {
    const vals = [a00, a11, a22];
    const vecs = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const idx = [0, 1, 2];
    idx.sort((i, j) => vals[j] - vals[i]);
    return {
      values: [vals[idx[0]], vals[idx[1]], vals[idx[2]]],
      vectors: [vecs[idx[0]], vecs[idx[1]], vecs[idx[2]]]
    };
  }
  const q = (a00 + a11 + a22) / 3;
  const p2 = (a00 - q) * (a00 - q) + (a11 - q) * (a11 - q) + (a22 - q) * (a22 - q) + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  const b00 = (a00 - q) / p, b01 = a01 / p, b02 = a02 / p;
  const b11 = (a11 - q) / p, b12 = a12 / p;
  const b22 = (a22 - q) / p;
  const detB = b00 * (b11 * b22 - b12 * b12) - b01 * (b01 * b22 - b12 * b02) + b02 * (b01 * b12 - b11 * b02);
  const r = Math.max(-1, Math.min(1, detB / 2));
  const phi = Math.acos(r) / 3;
  const eig1 = q + 2 * p * Math.cos(phi);
  const eig3 = q + 2 * p * Math.cos(phi + TWO_PI_OVER_3);
  const eig2 = 3 * q - eig1 - eig3;
  const v1 = nullVec(a00, a01, a02, a11, a12, a22, eig1);
  const v3 = nullVec(a00, a01, a02, a11, a12, a22, eig3);
  let v2 = cross3(v1, v3);
  let len2 = Math.sqrt(v2[0] * v2[0] + v2[1] * v2[1] + v2[2] * v2[2]);
  if (len2 > 1e-10) {
    v2 = [v2[0] / len2, v2[1] / len2, v2[2] / len2];
  } else {
    v2 = perpendicular(v1);
    const v3new = cross3(v1, v2);
    v3[0] = v3new[0];
    v3[1] = v3new[1];
    v3[2] = v3new[2];
  }
  return {
    values: [eig1, eig2, eig3],
    vectors: [v1, v2, v3]
  };
}
function nullVec(a00, a01, a02, a11, a12, a22, lam) {
  const r0 = [a00 - lam, a01, a02];
  const r1 = [a01, a11 - lam, a12];
  const r2 = [a02, a12, a22 - lam];
  const c01 = cross3(r0, r1);
  const c02 = cross3(r0, r2);
  const c12 = cross3(r1, r2);
  const l01 = c01[0] * c01[0] + c01[1] * c01[1] + c01[2] * c01[2];
  const l02 = c02[0] * c02[0] + c02[1] * c02[1] + c02[2] * c02[2];
  const l12 = c12[0] * c12[0] + c12[1] * c12[1] + c12[2] * c12[2];
  let v, len;
  if (l01 >= l02 && l01 >= l12) {
    v = c01;
    len = Math.sqrt(l01);
  } else if (l02 >= l12) {
    v = c02;
    len = Math.sqrt(l02);
  } else {
    v = c12;
    len = Math.sqrt(l12);
  }
  if (len < 1e-14) return [1, 0, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}
function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}
function perpendicular(v) {
  const ax = Math.abs(v[0]), ay = Math.abs(v[1]), az = Math.abs(v[2]);
  let u;
  if (ax <= ay && ax <= az) u = [0, -v[2], v[1]];
  else if (ay <= ax && ay <= az) u = [-v[2], 0, v[0]];
  else u = [-v[1], v[0], 0];
  const len = Math.sqrt(u[0] * u[0] + u[1] * u[1] + u[2] * u[2]);
  return [u[0] / len, u[1] / len, u[2] / len];
}

// src/statistics.js
function resultant(dcos) {
  const s = [0, 0, 0];
  for (const d of dcos) {
    s[0] += d[0];
    s[1] += d[1];
    s[2] += d[2];
  }
  return s;
}
function meanVector(dcos) {
  return normalize(resultant(dcos));
}
function fisherStats(dcos) {
  const n = dcos.length;
  const res = resultant(dcos);
  const R = length(res);
  const Rbar = R / n;
  const mean = R > 1e-10 ? scale(res, 1 / R) : [0, 0, -1];
  let kappa = Infinity;
  if (n > R + 1e-10) {
    kappa = n >= 3 ? (n - 2) / (n - R) : (n - 1) / (n - R);
  }
  let alpha95 = 0;
  if (n >= 2 && R > 1e-10 && n - R > 1e-10) {
    const cosA = 1 - (n - R) / R * (Math.pow(20, 1 / (n - 1)) - 1);
    alpha95 = Math.acos(Math.max(-1, Math.min(1, cosA))) * (180 / Math.PI);
  }
  return { n, R, Rbar, mean, kappa, alpha95 };
}
function orientationTensor(dcos) {
  const n = dcos.length;
  const T = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const d of dcos) {
    T[0] += d[0] * d[0];
    T[1] += d[0] * d[1];
    T[2] += d[0] * d[2];
    T[3] += d[1] * d[0];
    T[4] += d[1] * d[1];
    T[5] += d[1] * d[2];
    T[6] += d[2] * d[0];
    T[7] += d[2] * d[1];
    T[8] += d[2] * d[2];
  }
  for (let k = 0; k < 9; k++) T[k] /= n;
  return T;
}
function principalAxes(dcos) {
  const T = orientationTensor(dcos);
  const { values, vectors } = symmetricEigen3(T);
  for (let i = 0; i < 3; i++) {
    if (vectors[i][2] > 0) {
      vectors[i] = negate(vectors[i]);
    }
  }
  const s1 = values[0], s2 = values[1], s3 = values[2];
  const K = Math.log(s1 / s2) / Math.log(s2 / s3);
  const C = Math.log(s1 / s3);
  const P = s1 - s2;
  const G = 2 * (s2 - s3);
  const R = 3 * s3;
  const n = dcos.length;
  const kappa1 = n * (s2 - s1);
  const kappa2 = n * (s3 - s1);
  return { eigenvalues: values, eigenvectors: vectors, K, C, P, G, R, kappa1, kappa2 };
}
export {
  Stereonet,
  SvgBuilder,
  cardinalPoints,
  computeContours,
  conversions_exports as conversions,
  curves_exports as curves,
  equal_angle_exports as equalAngle,
  equal_area_exports as equalArea,
  generateNet,
  io_exports as io,
  mat3_exports as mat3,
  deepMerge as mergeStyles,
  statistics_exports as statistics,
  defaults as styleDefaults,
  symmetricEigen3,
  vec3_exports as vec3
};
