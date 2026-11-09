// Toolbar icon overlays drawn into the icon itself. The browser's native badge has a fixed, small size.

const SIZES = [16, 32] as const;
const ACCENT = '#f06c00'; // dark-theme accent (tangerine)
const SLATE = '#5f636b'; // dark-theme dim gray (readable on light and dark toolbars)

type IconUrl = (size: number) => string;
let base: Promise<ImageBitmap[]> | null = null;

function loadBase(iconUrl: IconUrl): Promise<ImageBitmap[]> {
  base ??= Promise.all(SIZES.map(async (s) => createImageBitmap(await (await fetch(iconUrl(s))).blob()))).catch((e) => {
    base = null;
    throw e;
  });
  return base;
}

/** Faded base icon plus whatever `draw` paints on top, at every toolbar size. */
async function overlay(
  iconUrl: IconUrl,
  draw: (g: OffscreenCanvasRenderingContext2D, size: number) => void,
): Promise<Record<number, ImageData>> {
  const bitmaps = await loadBase(iconUrl);
  const out: Record<number, ImageData> = {};
  SIZES.forEach((size, i) => {
    const g = new OffscreenCanvas(size, size).getContext('2d')!;
    g.globalAlpha = 0.5;
    g.drawImage(bitmaps[i]!, 0, 0, size, size);
    g.globalAlpha = 1;
    draw(g, size);
    out[size] = g.getImageData(0, 0, size, size);
  });
  return out;
}

/** `text` in a large pill over the bottom-right of the icon. */
export function countIcon(text: string, iconUrl: IconUrl) {
  return overlay(iconUrl, (g, size) => {
    const h = Math.round(size * 0.75);
    g.font = `bold ${Math.round(h * 0.85)}px system-ui, sans-serif`;
    const w = Math.min(size, Math.max(h, Math.ceil(g.measureText(text).width) + Math.round(size * 0.15)));
    const x = size - w;
    const y = size - h;
    g.fillStyle = ACCENT;
    g.beginPath();
    g.roundRect(x, y, w, h, h / 2);
    g.fill();
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, x + w / 2, y + h / 2 + size * 0.03, w);
  });
}

/** A padlock in a dark circle over the bottom-right of the icon. */
export function lockIcon(iconUrl: IconUrl) {
  return overlay(iconUrl, (g, size) => {
    const d = size * 0.75;
    const cx = size - d / 2;
    const cy = size - d / 2;
    g.fillStyle = SLATE;
    g.beginPath();
    g.arc(cx, cy, d / 2, 0, Math.PI * 2);
    g.fill();

    // Body
    const bw = d * 0.5;
    const bh = d * 0.34;
    const bx = cx - bw / 2;
    const by = cy - d * 0.02;
    g.fillStyle = '#fff';
    g.beginPath();
    g.roundRect(bx, by, bw, bh, d * 0.05);
    g.fill();
    // Shackle: two legs rising from the body, joined by an arch.
    const r = bw * 0.3;
    const top = by - d * 0.12;
    g.strokeStyle = '#fff';
    g.lineWidth = Math.max(1.5, d * 0.1);
    g.beginPath();
    g.moveTo(cx - r, by);
    g.lineTo(cx - r, top);
    g.arc(cx, top, r, Math.PI, 0);
    g.lineTo(cx + r, by);
    g.stroke();
  });
}
