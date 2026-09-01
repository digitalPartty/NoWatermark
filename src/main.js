import { inpaintTelea } from './telea.js';
import { inpaintNS } from './ns.js';

const MAX_SIDE = 2048;
const MAX_FILE_SIZE = 10 * 1024 * 1024;

const $ = (id) => document.getElementById(id);
const dropzone = $('dropzone');
const fileInput = $('fileInput');
const uploadView = $('uploadView');
const editorView = $('editorView');
const baseCanvas = $('baseCanvas');
const maskCanvas = $('maskCanvas');
const brushSize = $('brushSize');
const brushVal = $('brushVal');
const radiusInput = $('radius');
const radiusVal = $('radiusVal');
const btnUndo = $('btnUndo');
const btnClear = $('btnClear');
const btnProcess = $('btnProcess');
const btnDownload = $('btnDownload');
const btnReset = $('btnReset');
const statusEl = $('status');

const baseCtx = baseCanvas.getContext('2d', { willReadFrequently: true });
const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });

let strokes = []; // { size, points: [{x, y}] }
let painting = false;
let lastPoint = null;

/* ---------------- 上传 ---------------- */

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') fileInput.click();
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) loadFile(fileInput.files[0]);
  fileInput.value = '';
});

['dragover', 'dragenter'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (ev === 'drop') {
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) loadFile(file);
    }
  })
);

document.addEventListener('paste', (e) => {
  if (!editorView.hidden) return;
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      loadFile(item.getAsFile());
      break;
    }
  }
});

function fail(msg) {
  setStatus(msg, 'err');
}

function loadFile(file) {
  if (!file.type.startsWith('image/')) return fail('请选择图片文件（PNG / JPEG / WebP）');
  if (file.size > MAX_FILE_SIZE) return fail('图片超过 10MB 限制');
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    openEditor(img);
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    fail('图片读取失败，请换一张试试');
  };
  img.src = url;
}

function openEditor(img) {
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  if (Math.max(w, h) > MAX_SIDE) {
    const s = MAX_SIDE / Math.max(w, h);
    w = Math.round(w * s);
    h = Math.round(h * s);
  }
  baseCanvas.width = maskCanvas.width = w;
  baseCanvas.height = maskCanvas.height = h;
  baseCtx.drawImage(img, 0, 0, w, h);
  clearMask();
  strokes = [];
  btnDownload.disabled = true;
  uploadView.hidden = true;
  editorView.hidden = false;
  setStatus(
    `已加载 ${w}×${h} 图片，请涂抹要移除的水印区域。`
  );
}

/* ---------------- 涂抹遮罩 ---------------- */

function canvasPoint(e) {
  const rect = maskCanvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * maskCanvas.width,
    y: ((e.clientY - rect.top) / rect.height) * maskCanvas.height,
  };
}

maskCanvas.addEventListener('pointerdown', (e) => {
  if (btnProcess.disabled) return;
  e.preventDefault();
  maskCanvas.setPointerCapture(e.pointerId);
  painting = true;
  lastPoint = canvasPoint(e);
  strokes.push({ size: +brushSize.value, points: [lastPoint] });
  drawSegment(lastPoint, lastPoint, +brushSize.value);
});

maskCanvas.addEventListener('pointermove', (e) => {
  if (!painting) return;
  const p = canvasPoint(e);
  drawSegment(lastPoint, p, +brushSize.value);
  strokes[strokes.length - 1].points.push(p);
  lastPoint = p;
});

['pointerup', 'pointercancel'].forEach((ev) =>
  maskCanvas.addEventListener(ev, () => {
    painting = false;
    lastPoint = null;
  })
);

function drawSegment(a, b, size) {
  maskCtx.strokeStyle = '#ff4040';
  maskCtx.fillStyle = '#ff4040';
  maskCtx.lineWidth = size;
  maskCtx.lineCap = 'round';
  maskCtx.lineJoin = 'round';
  if (a === b) {
    maskCtx.beginPath();
    maskCtx.arc(a.x, a.y, size / 2, 0, Math.PI * 2);
    maskCtx.fill();
  } else {
    maskCtx.beginPath();
    maskCtx.moveTo(a.x, a.y);
    maskCtx.lineTo(b.x, b.y);
    maskCtx.stroke();
  }
}

function replayStrokes() {
  maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  for (const s of strokes) {
    if (!s.points.length) continue;
    maskCtx.strokeStyle = '#ff4040';
    maskCtx.lineWidth = s.size;
    maskCtx.lineCap = 'round';
    maskCtx.lineJoin = 'round';
    maskCtx.beginPath();
    maskCtx.moveTo(s.points[0].x, s.points[0].y);
    for (let i = 1; i < s.points.length; i++) maskCtx.lineTo(s.points[i].x, s.points[i].y);
    maskCtx.stroke();
  }
}

function clearMask() {
  maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  strokes = [];
}

function undo() {
  if (btnProcess.disabled) return;
  strokes.pop();
  replayStrokes();
}

btnUndo.addEventListener('click', undo);
btnClear.addEventListener('click', () => {
  if (!btnProcess.disabled) clearMask();
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !editorView.hidden) {
    e.preventDefault();
    undo();
  }
});

/* ---------------- 参数 ---------------- */

brushSize.addEventListener('input', () => (brushVal.textContent = brushSize.value));
radiusInput.addEventListener('input', () => (radiusVal.textContent = radiusInput.value));

/* ---------------- 处理 ---------------- */

// 裁剪到遮罩包围盒附近再运行算法，大幅提速
function processCrop(imageData, mask, w, h, radius, fn) {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return false;

  const margin = Math.max(12, radius * 3);
  const x0 = Math.max(0, minX - margin);
  const y0 = Math.max(0, minY - margin);
  const x1 = Math.min(w - 1, maxX + margin);
  const y1 = Math.min(h - 1, maxY + margin);
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;

  const sub = new Uint8ClampedArray(cw * ch * 4);
  const subMask = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const src = ((y0 + y) * w + (x0 + x)) * 4;
      const dst = (y * cw + x) * 4;
      sub[dst] = imageData.data[src];
      sub[dst + 1] = imageData.data[src + 1];
      sub[dst + 2] = imageData.data[src + 2];
      sub[dst + 3] = imageData.data[src + 3];
      subMask[y * cw + x] = mask[(y0 + y) * w + (x0 + x)] ? 1 : 0;
    }
  }

  fn(sub, subMask, cw, ch, radius);

  // 只回写被标记的像素
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const m = subMask[y * cw + x];
      if (!m) continue;
      const src = (y * cw + x) * 4;
      const dst = ((y0 + y) * w + (x0 + x)) * 4;
      imageData.data[dst] = sub[src];
      imageData.data[dst + 1] = sub[src + 1];
      imageData.data[dst + 2] = sub[src + 2];
      imageData.data[dst + 3] = sub[src + 3];
    }
  }
  return true;
}

function setStatus(msg, kind = '') {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + kind;
}

btnProcess.addEventListener('click', async () => {
  if (btnProcess.disabled) return;

  const w = baseCanvas.width;
  const h = baseCanvas.height;
  const maskData = maskCtx.getImageData(0, 0, w, h).data;
  const mask = new Uint8Array(w * h);
  let count = 0;
  for (let p = 0; p < w * h; p++) {
    if (maskData[p * 4 + 3] > 8) {
      mask[p] = 1;
      count++;
    }
  }
  if (!count) return setStatus('请先用笔刷涂抹要移除的水印区域', 'err');

  const useNS = document.querySelector('input[name="algo"]:checked').value === 'ns';
  const algo = useNS ? inpaintNS : inpaintTelea;
  const radius = +radiusInput.value;
  const isLarge = count > 30000;

  [btnProcess, btnUndo, btnClear].forEach((b) => (b.disabled = true));
  setStatus('处理中…');

  await new Promise((r) => setTimeout(r, 30)); // 让 UI 先刷新
  const t0 = performance.now();
  let ok = false;
  try {
    const imageData = baseCtx.getImageData(0, 0, w, h);
    ok = processCrop(imageData, mask, w, h, radius, algo);
    if (ok) {
      baseCtx.putImageData(imageData, 0, 0);
      clearMask();
    }
  } catch (err) {
    console.error(err);
    setStatus('处理失败：' + err.message, 'err');
  }
  const secs = (performance.now() - t0) / 1000;

  [btnProcess, btnUndo, btnClear].forEach((b) => (b.disabled = false));
  if (ok) {
    btnDownload.disabled = false;
    let msg = `完成！共修复 ${count} 个像素，用时 ${secs.toFixed(2)} 秒。可继续涂抹并重复处理，或点击下载。`;
    if (!useNS && isLarge)
      msg += '（提示：大面积区域改用 Navier-Stokes 算法会更平滑）';
    setStatus(msg, 'ok');
  }
});

/* ---------------- 下载 / 重置 ---------------- */

btnDownload.addEventListener('click', () => {
  if (btnDownload.disabled) return;
  baseCanvas.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `no-watermark-${Date.now()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
});

btnReset.addEventListener('click', () => {
  clearMask();
  btnDownload.disabled = true;
  editorView.hidden = true;
  uploadView.hidden = false;
  setStatus('');
});
