// Tuli's artwork lives in assets/ (profile-pic.png and banner.png, the same files the bot
// uses on Discord). This turns it into README-sized pictures, and draws simple avatars for
// the example members in screenshots.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ASSETS = join(import.meta.dirname, "..", "..", "assets");

/** An asset as a data URI, so it can be drawn in a page without a web server. */
export function asset(name: string): string {
  return `data:image/png;base64,${readFileSync(join(ASSETS, name)).toString("base64")}`;
}

/** Part of a square picture, as fractions of its size: where the crop starts and how big it is. */
export interface Crop {
  left: number;
  top: number;
  size: number;
}

/** A page with one picture scaled to fit a frame (rounded corners, a circle...), optionally cropped. */
export function framePage(src: string, width: number, height: number, radius = "0", crop?: Crop): string {
  const picture = crop
    ? `position:absolute;width:${100 / crop.size}%;left:${(-crop.left / crop.size) * 100}%;top:${(-crop.top / crop.size) * 100}%`
    : "width:100%;height:100%;object-fit:cover";
  return `<!doctype html><html><body style="margin:0;background:transparent">
  <div id="shot" style="position:relative;width:${width}px;height:${height}px;border-radius:${radius};overflow:hidden;background:#fff">
    <img src="${src}" style="display:block;${picture}">
  </div></body></html>`;
}

/** A round avatar with someone's initial, for the example members in screenshots. */
export function initialAvatar(name: string, color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><circle cx="40" cy="40" r="40" fill="${color}"/><text x="40" y="52" font-family="Helvetica, Arial, sans-serif" font-size="34" font-weight="700" fill="#fff" text-anchor="middle">${name[0]}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
