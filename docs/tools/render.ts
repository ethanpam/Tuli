// Regenerates every picture in docs/images: `npm run docs:images`.
// Runs Tuli's real commands against a pretend server (see scenes.ts), draws the results the
// way Discord shows them, and saves PNG screenshots and GIF animations.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import gifenc from "gifenc";
import { PNG } from "pngjs";
import puppeteer, { type Page } from "puppeteer-core";
import { asset, framePage } from "./brand.js";
import { shotPage } from "./discord-html.js";
import { buildScenes } from "./scenes.js";

const { applyPalette, GIFEncoder, quantize } = gifenc;
const OUT = join(import.meta.dirname, "..", "images");
const CHROME =
  process.env.CHROME_PATH ??
  {
    darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    win32: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    linux: "/usr/bin/google-chrome",
  }[process.platform as string];

/** Loads a page and screenshots its #shot element. */
async function capture(page: Page, html: string, scale: number): Promise<Buffer> {
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: scale });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const element = await page.$("#shot");
  if (!element) throw new Error("Nothing to capture");
  return Buffer.from(await element.screenshot({ omitBackground: true }));
}

async function measureHeight(page: Page, html: string): Promise<number> {
  await page.setContent(html, { waitUntil: "load" });
  return page.evaluate(() => document.querySelector(".window")?.getBoundingClientRect().height ?? 0);
}

function save(name: string, data: Buffer | Uint8Array) {
  writeFileSync(join(OUT, name), data);
  console.log(`  docs/images/${name} (${Math.round(data.length / 1024)} KB)`);
}

mkdirSync(OUT, { recursive: true });
if (!CHROME) throw new Error("Set CHROME_PATH to your Chrome or Chromium executable.");
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();

// README-sized copies of Tuli's artwork in assets/ (the originals are too big for a web page).
console.log("Artwork:");
const profilePicture = asset("profile-pic.png");
// Avatars are shown small, so zoom in on Tuli's face, ribbon and thumbs-up.
const face = { left: 0.1575, top: 0.085, size: 0.66 };
save("banner.png", await capture(page, framePage(asset("banner.png"), 1600, 800, "28px"), 1));
save("tuli-avatar.png", await capture(page, framePage(profilePicture, 512, 512, "50%", face), 1));
const smallAvatar = await capture(page, framePage(profilePicture, 160, 160, "50%", face), 1);

// Tuli reports handler errors with console.error; any error means a picture would be wrong.
const errors: unknown[][] = [];
const logError = console.error;
console.error = (...args: unknown[]) => void errors.push(args);
const { shots, animations, directory } = await buildScenes(`data:image/png;base64,${smallAvatar.toString("base64")}`);
console.error = logError;
if (errors.length) {
  for (const args of errors) logError(...args);
  await browser.close();
  throw new Error(`${errors.length} errors while running the scenes; no screenshots were written.`);
}

console.log("Screenshots:");
const names: Record<string, string> = {
  greet: "greet.png",
  help: "help.png",
  quote: "quote-save.png",
  quoteList: "quote-list.png",
  points: "points.png",
  levelUp: "level-up.png",
  rank: "rank.png",
  leaderboard: "leaderboard.png",
  shopOrder: "shop-order.png",
  questionOpen: "question-open.png",
  triviaResults: "question-results.png",
  trueFalse: "question-truefalse.png",
  scam: "scam-report.png",
  scamDm: "scam-dm.png",
  feed: "feed.png",
  setup: "setup.png",
};
for (const [key, shot] of Object.entries(shots)) {
  save(names[key] ?? `${key}.png`, await capture(page, shotPage(shot, directory), 2));
}

console.log("Animations:");
for (const animation of animations) {
  // Every frame gets the same height, so the GIF doesn't jump around.
  let height = 0;
  for (const frame of animation.frames)
    height = Math.max(height, await measureHeight(page, shotPage(frame.shot, directory, { flat: true })));
  const gif = GIFEncoder();
  for (const [index, frame] of animation.frames.entries()) {
    const image = await capture(page, shotPage(frame.shot, directory, { flat: true, minHeight: height }), 1);
    // FRAMES_DIR=some/folder saves each frame as a PNG too, for checking animations frame by frame.
    if (process.env.FRAMES_DIR)
      writeFileSync(join(process.env.FRAMES_DIR, `${animation.name}-${index + 1}.png`), image);
    const png = PNG.sync.read(image);
    const palette = quantize(png.data, 256);
    gif.writeFrame(applyPalette(png.data, palette), png.width, png.height, { palette, delay: frame.delay });
  }
  gif.finish();
  save(`${animation.name}.gif`, gif.bytes());
}

await browser.close();
