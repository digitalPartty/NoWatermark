// Navier-Stokes 图像修复 —— Bertalmío 等人提出的流体动力学类比方法
// 论文: M. Bertalmío, A. L. Bertozzi, G. Sapiro, "Navier-Stokes, Fluid
//       Dynamics, and Image and Video Inpainting", CVPR 2001.
//
// 实现:
//   1) 初始化 —— 多源 BFS 最近色填充 + red-black SOR 求解 ΔI = 0（调和平滑）
//   2) 输运迭代 —— 沿等照度线方向 ∇⊥I 传播平滑度 ∇(ΔI):
//          ∂I/∂t = ∇⊥(I_ε) · ∇(ΔI)
//      其中几何方向 N = ∇⊥(I_ε) 由平滑后亮度图的梯度旋转 90° 得到。
//
// 参数同 inpaintTelea，radius 映射为迭代强度。

export function inpaintNS(image, mask, width, height, radius = 3) {
  const N = width * height;
  const flags = new Uint8Array(N); // 0 = KNOWN, 1 = INSIDE
  const F = new Float32Array(N * 4);

  let count = 0;
  for (let p = 0; p < N; p++) {
    if (mask[p]) {
      flags[p] = 1;
      count++;
    }
    for (let ch = 0; ch < 4; ch++) F[p * 4 + ch] = image[p * 4 + ch];
  }
  if (count === 0) return;

  const inside = new Int32Array(count);
  {
    let k = 0;
    for (let p = 0; p < N; p++) if (flags[p]) inside[k++] = p;
  }

  const clampX = (x) => (x < 0 ? 0 : x >= width ? width - 1 : x);
  const clampY = (y) => (y < 0 ? 0 : y >= height ? height - 1 : y);
  const at = (x, y, ch) => F[(clampY(y) * width + clampX(x)) * 4 + ch];

  // ---------- 阶段 1a: 多源 BFS 初始化 ----------
  // 用最近已知像素颜色向内填充，避免把水印残留像素带入后续求解
  const dist = new Int32Array(N).fill(-1);
  const queue = new Int32Array(count);
  let qh = 0;
  let qt = 0;
  for (let n = 0; n < count; n++) {
    const p = inside[n];
    const x = p % width;
    const y = (p / width) | 0;
    const left = x > 0 && !flags[p - 1];
    const right = x < width - 1 && !flags[p + 1];
    const up = y > 0 && !flags[p - width];
    const down = y < height - 1 && !flags[p + width];
    if (left || right || up || down) {
      dist[p] = 0;
      queue[qt++] = p;
      let r = 0;
      let g = 0;
      let b = 0;
      let k = 0;
      if (left) {
        const q = (p - 1) * 4;
        r += F[q]; g += F[q + 1]; b += F[q + 2]; k++;
      }
      if (right) {
        const q = (p + 1) * 4;
        r += F[q]; g += F[q + 1]; b += F[q + 2]; k++;
      }
      if (up) {
        const q = (p - width) * 4;
        r += F[q]; g += F[q + 1]; b += F[q + 2]; k++;
      }
      if (down) {
        const q = (p + width) * 4;
        r += F[q]; g += F[q + 1]; b += F[q + 2]; k++;
      }
      F[p * 4] = r / k;
      F[p * 4 + 1] = g / k;
      F[p * 4 + 2] = b / k;
    }
  }
  while (qh < qt) {
    const p = queue[qh++];
    const x = p % width;
    const y = (p / width) | 0;
    const push = (q) => {
      if (q >= 0 && flags[q] && dist[q] === -1) {
        dist[q] = dist[p] + 1;
        F[q * 4] = F[p * 4];
        F[q * 4 + 1] = F[p * 4 + 1];
        F[q * 4 + 2] = F[p * 4 + 2];
        queue[qt++] = q;
      }
    };
    if (x > 0) push(p - 1);
    if (x < width - 1) push(p + 1);
    if (y > 0) push(p - width);
    if (y < height - 1) push(p + width);
  }

  // ---------- 阶段 1b: 调和求解 (red-black SOR 超松弛) ----------
  // BFS 初始化已接近解，SOR 收敛速度 O(h)，大区域也能快速收敛
  const OMEGA = 1.8;
  let maxDiff = 1e9;
  const sor = (parity) => {
    for (let n = 0; n < count; n++) {
      const p = inside[n];
      const x = p % width;
      const y = (p / width) | 0;
      if (((x + y) & 1) === parity) {
        for (let ch = 0; ch < 3; ch++) {
          const avg =
            0.25 *
            (at(x - 1, y, ch) +
              at(x + 1, y, ch) +
              at(x, y - 1, ch) +
              at(x, y + 1, ch));
          const d = OMEGA * (avg - F[p * 4 + ch]);
          if (d > maxDiff || -d > maxDiff) maxDiff = d > 0 ? d : -d;
          F[p * 4 + ch] += d;
        }
      }
    }
  };

  for (let s = 0; s < 800 && maxDiff > 0.25; s++) {
    maxDiff = 0;
    sor(0);
    sor(1);
  }

  // ---------- 阶段 2: 沿等照度线的输运迭代 ----------
  // ∂I/∂t = ∇⊥(I_ε) · ∇(ΔI)
  // 三阶 PDE 用显式欧拉迭代，需小步长 + 限幅 + 调和阻尼保证稳定
  const nIter = Math.min(120, Math.round(40 + radius * 10));
  const dt = 0.03;
  const D_MAX = 2.0; // 单次迭代最大变化
  const DAMP = 0.12; // 向调和均值收缩的阻尼系数
  const DRIFT_MAX = 50; // 相对调和初始化的最大总漂移

  const init = Float32Array.from(F); // 调和初始化结果，用于钳制总漂移
  const B = new Float32Array(N); // 亮度图
  const lum = () => {
    for (let p = 0; p < N; p++) {
      const q = p * 4;
      B[p] = (F[q] + F[q + 1] + F[q + 2]) * (1 / 3);
    }
  };

  // (x,y) 处通道 ch 的拉普拉斯
  const lap = (x, y, ch) =>
    at(x - 1, y, ch) + at(x + 1, y, ch) + at(x, y - 1, ch) + at(x, y + 1, ch) -
    4 * at(x, y, ch);

  const Bc = (x, y) => B[clampY(y) * width + clampX(x)];

  const delta = new Float32Array(N * 4);

  for (let it = 0; it < nIter; it++) {
    lum();

    for (let n = 0; n < count; n++) {
      const p = inside[n];
      const x = p % width;
      const y = (p / width) | 0;

      // 等照度线方向：平滑亮度图梯度旋转 90°
      const bx = (Bc(x + 1, y) - Bc(x - 1, y)) * 0.5;
      const by = (Bc(x, y + 1) - Bc(x, y - 1)) * 0.5;
      const nb = Math.sqrt(bx * bx + by * by);
      let nx = 0;
      let ny = 0;
      if (nb > 1e-3) {
        nx = -by / nb;
        ny = bx / nb;
      }

      for (let ch = 0; ch < 3; ch++) {
        // ∇(ΔI) 沿等照度线方向的投影
        const glx = (lap(x + 1, y, ch) - lap(x - 1, y, ch)) * 0.5;
        const gly = (lap(x, y + 1, ch) - lap(x, y - 1, ch)) * 0.5;
        let d = (nx * glx + ny * gly) * dt;
        if (d > D_MAX) d = D_MAX;
        else if (d < -D_MAX) d = -D_MAX;
        delta[p * 4 + ch] = d;
      }
    }

    // 应用输运 + 调和阻尼 + 总漂移钳制
    for (let n = 0; n < count; n++) {
      const p = inside[n];
      const x = p % width;
      const y = (p / width) | 0;
      for (let ch = 0; ch < 3; ch++) {
        const q = p * 4 + ch;
        let v = F[q] + delta[q];
        const avg = 0.25 * (at(x - 1, y, ch) + at(x + 1, y, ch) + at(x, y - 1, ch) + at(x, y + 1, ch));
        v = v * (1 - DAMP) + avg * DAMP;
        const lo = init[q] - DRIFT_MAX;
        const hi = init[q] + DRIFT_MAX;
        F[q] = v < lo ? lo : v > hi ? hi : v;
      }
    }
  }

  // ---------- 写回 ----------
  for (let n = 0; n < count; n++) {
    const p = inside[n];
    const q = p * 4;
    image[q] = F[q];
    image[q + 1] = F[q + 1];
    image[q + 2] = F[q + 2];
    image[q + 3] = 255;
  }
}
