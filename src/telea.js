// Telea 图像修复 —— 快速行进法 (Fast Marching Method)
// 论文: A. Telea, "An Image Inpainting Technique Based on the Fast Marching
//       Method", Journal of Graphics Tools, 2004.
//
// image: Uint8ClampedArray (RGBA, 长度 w*h*4，就地修改)
// mask:  Uint8Array (w*h, 非 0 表示需要修复)
// radius: 参与加权的已知像素邻域半径

const KNOWN = 0;
const BAND = 1;
const INSIDE = 2;
const INF = 1e6;

class MinHeap {
  constructor() {
    this.t = [];
    this.i = [];
  }
  get size() {
    return this.t.length;
  }
  push(tv, iv) {
    const T = this.t;
    const I = this.i;
    let n = T.length;
    T.push(tv);
    I.push(iv);
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (T[p] <= T[n]) break;
      const tt = T[p]; T[p] = T[n]; T[n] = tt;
      const ti = I[p]; I[p] = I[n]; I[n] = ti;
      n = p;
    }
  }
  pop() {
    const T = this.t;
    const I = this.i;
    const len = T.length;
    const topT = T[0];
    const topI = I[0];
    if (len === 1) {
      T.pop();
      I.pop();
      return [topT, topI];
    }
    T[0] = T[len - 1];
    I[0] = I[len - 1];
    T.pop();
    I.pop();
    let n = 0;
    for (;;) {
      const l = 2 * n + 1;
      const r = l + 1;
      let m = n;
      if (l < T.length && T[l] < T[m]) m = l;
      if (r < T.length && T[r] < T[m]) m = r;
      if (m === n) break;
      const tt = T[m]; T[m] = T[n]; T[n] = tt;
      const ti = I[m]; I[m] = I[n]; I[n] = ti;
      n = m;
    }
    return [topT, topI];
  }
}

export function inpaintTelea(image, mask, width, height, radius = 3) {
  const N = width * height;
  const flags = new Uint8Array(N);
  const T = new Float32Array(N);
  let count = 0;

  for (let p = 0; p < N; p++) {
    if (mask[p]) {
      flags[p] = INSIDE;
      T[p] = INF;
      count++;
    } else {
      flags[p] = KNOWN;
      T[p] = 0;
    }
  }
  if (count === 0) return;

  const r2max = radius * radius;

  // 返回 (x,y) 处有限的 T 值（KNOWN/BAND），INSIDE 或越界返回 INF
  const finiteT = (x, y) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return INF;
    const p = y * width + x;
    return flags[p] === INSIDE ? INF : T[p];
  };

  // Eikonal 方程 Godunov 求解器
  const solve = (x, y) => {
    let sol = INF;
    {
      const a = finiteT(x - 1, y);
      const b = finiteT(x + 1, y);
      if (a < INF || b < INF) {
        if (a < INF && b < INF) {
          const d = a - b;
          sol =
            Math.abs(d) < 1
              ? (a + b + Math.sqrt(2 - d * d)) * 0.5
              : 1 + Math.min(a, b);
        } else {
          sol = 1 + (a < INF ? a : b);
        }
      }
    }
    {
      const a = finiteT(x, y - 1);
      const b = finiteT(x, y + 1);
      if (a < INF || b < INF) {
        let sy;
        if (a < INF && b < INF) {
          const d = a - b;
          sy =
            Math.abs(d) < 1
              ? (a + b + Math.sqrt(2 - d * d)) * 0.5
              : 1 + Math.min(a, b);
        } else {
          sy = 1 + (a < INF ? a : b);
        }
        if (sy < sol) sol = sy;
      }
    }
    return sol;
  };

  // 初始窄带：与已知区域相邻的待修复像素
  const heap = new MinHeap();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (flags[p] !== INSIDE) continue;
      if (
        finiteT(x - 1, y) < INF ||
        finiteT(x + 1, y) < INF ||
        finiteT(x, y - 1) < INF ||
        finiteT(x, y + 1) < INF
      ) {
        flags[p] = BAND;
        T[p] = solve(x, y);
        heap.push(T[p], p);
      }
    }
  }

  // 用半径内已知像素的加权平均修复像素 p
  const inpaintPixel = (p, x, y) => {
    let gx = 0;
    let gy = 0;
    {
      const l = finiteT(x - 1, y);
      const r = finiteT(x + 1, y);
      const u = finiteT(x, y - 1);
      const d = finiteT(x, y + 1);
      if (l < INF && r < INF) gx = (r - l) * 0.5;
      else if (r < INF) gx = 1;
      else if (l < INF) gx = -1;
      if (u < INF && d < INF) gy = (d - u) * 0.5;
      else if (d < INF) gy = 1;
      else if (u < INF) gy = -1;
    }
    const gnorm = Math.sqrt(gx * gx + gy * gy);

    const x0 = Math.max(0, x - radius);
    const x1 = Math.min(width - 1, x + radius);
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);

    let wsum = 0;
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;

    for (let qy = y0; qy <= y1; qy++) {
      const dy = qy - y;
      for (let qx = x0; qx <= x1; qx++) {
        const dx = qx - x;
        const d2 = dx * dx + dy * dy;
        if (d2 === 0 || d2 > r2max) continue;
        const q = qy * width + qx;
        if (flags[q] !== KNOWN) continue;

        const dist = Math.sqrt(d2);
        const dst = 1 / (d2 + 1e-6); // 几何距离项
        const lev = 1 / (1 + Math.abs(T[q] - T[p])); // 等值线相似项
        const dirw =
          Math.abs(gx * dx + gy * dy) / (gnorm * dist + 1e-6) + 1e-6; // 方向项

        const w = dst * lev * dirw;
        wsum += w;
        const q4 = q * 4;
        s0 += w * image[q4];
        s1 += w * image[q4 + 1];
        s2 += w * image[q4 + 2];
      }
    }

    if (wsum > 0) {
      const p4 = p * 4;
      image[p4] = s0 / wsum;
      image[p4 + 1] = s1 / wsum;
      image[p4 + 2] = s2 / wsum;
      image[p4 + 3] = 255;
    }
  };

  // 快速行进主循环
  while (heap.size > 0) {
    const [, p] = heap.pop();
    if (flags[p] !== BAND) continue; // 懒删除的过期项
    flags[p] = KNOWN;
    const x = p % width;
    const y = (p / width) | 0;

    inpaintPixel(p, x, y);

    // 4 邻域中仍为 INSIDE 的像素进入窄带
    if (x > 0 && flags[p - 1] === INSIDE) {
      flags[p - 1] = BAND;
      T[p - 1] = solve(x - 1, y);
      heap.push(T[p - 1], p - 1);
    }
    if (x < width - 1 && flags[p + 1] === INSIDE) {
      flags[p + 1] = BAND;
      T[p + 1] = solve(x + 1, y);
      heap.push(T[p + 1], p + 1);
    }
    if (y > 0 && flags[p - width] === INSIDE) {
      flags[p - width] = BAND;
      T[p - width] = solve(x, y - 1);
      heap.push(T[p - width], p - width);
    }
    if (y < height - 1 && flags[p + width] === INSIDE) {
      flags[p + width] = BAND;
      T[p + width] = solve(x, y + 1);
      heap.push(T[p + width], p + width);
    }
  }

  // ---------- 大区域后处理：深度调和平滑 ----------
  // FMM 逐像素延伸在大区域深处会产生平坦斑块（马赛克感）。
  // 对遮罩深处做加权松弛：边界 8px 内保留 Telea 的结构延伸，深处趋向调和平滑。
  if (count > 3000) {
    // BFS 计算遮罩内像素到遮罩边界的深度
    const depth = new Int32Array(N).fill(-1);
    const queue = new Int32Array(count);
    let qh = 0;
    let qt = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (!mask[p]) continue;
        if (
          (x > 0 && !mask[p - 1]) ||
          (x < width - 1 && !mask[p + 1]) ||
          (y > 0 && !mask[p - width]) ||
          (y < height - 1 && !mask[p + width])
        ) {
          depth[p] = 0;
          queue[qt++] = p;
        }
      }
    }
    while (qh < qt) {
      const p = queue[qh++];
      const x = p % width;
      const y = (p / width) | 0;
      const push = (q) => {
        if (q >= 0 && mask[q] && depth[q] === -1) {
          depth[q] = depth[p] + 1;
          queue[qt++] = q;
        }
      };
      if (x > 0) push(p - 1);
      if (x < width - 1) push(p + 1);
      if (y > 0) push(p - width);
      if (y < height - 1) push(p + width);
    }

    // 深度≥5 完全平滑，边界处权重趋近 0
    for (let sweep = 0; sweep < 16; sweep++) {
      for (let parity = 0; parity < 2; parity++) {
        for (let n = 0; n < qt; n++) {
          const p = queue[n];
          const x = p % width;
          const y = (p / width) | 0;
          if (((x + y) & 1) !== parity) continue;
          const w = Math.min(1, (depth[p] / 8) * 1.7);
          if (w <= 0) continue;
          for (let ch = 0; ch < 3; ch++) {
            const q = p * 4 + ch;
            let avg = 0;
            let k = 0;
            if (x > 0) {
              avg += image[q - 4];
              k++;
            }
            if (x < width - 1) {
              avg += image[q + 4];
              k++;
            }
            if (y > 0) {
              avg += image[q - width * 4];
              k++;
            }
            if (y < height - 1) {
              avg += image[q + width * 4];
              k++;
            }
            avg /= k;
            image[q] += w * (avg - image[q]);
          }
        }
      }
    }
  }
}
