// Tuli's logo and the README banner. The logo doubles as the bot's profile picture
// (docs/images/tuli-avatar.png): upload it in the Developer Portal → Bot → Icon.

export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="tuli-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6FA3FF"/>
      <stop offset="1" stop-color="#7C5CFF"/>
    </linearGradient>
  </defs>
  <circle cx="256" cy="256" r="256" fill="url(#tuli-bg)"/>
  <path d="M146 142h220a54 54 0 0 1 54 54v112a54 54 0 0 1-54 54H270l-64 54v-54h-60a54 54 0 0 1-54-54V196a54 54 0 0 1 54-54z" fill="#fff"/>
  <ellipse cx="206" cy="240" rx="23" ry="29" fill="#1E1F36"/>
  <ellipse cx="306" cy="240" rx="23" ry="29" fill="#1E1F36"/>
  <circle cx="214" cy="229" r="7" fill="#fff"/>
  <circle cx="314" cy="229" r="7" fill="#fff"/>
  <path d="M220 294q36 28 72 0" stroke="#1E1F36" stroke-width="15" fill="none" stroke-linecap="round"/>
  <path d="M398 86l12 30 30 12-30 12-12 30-12-30-30-12 30-12z" fill="#F7C948"/>
</svg>`;

export const LOGO_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(LOGO_SVG).toString("base64")}`;

/** A round avatar with someone's initial, for the example members in screenshots. */
export function initialAvatar(name: string, color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><circle cx="40" cy="40" r="40" fill="${color}"/><text x="40" y="52" font-family="Helvetica, Arial, sans-serif" font-size="34" font-weight="700" fill="#fff" text-anchor="middle">${name[0]}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export function avatarPage(): string {
  return `<!doctype html><html><body style="margin:0;background:transparent">
  <div id="shot" style="width:512px;height:512px">${LOGO_SVG}</div></body></html>`;
}

const FEATURES = [
  "💬 Quotes",
  "🪙 Points",
  "🏆 Levels",
  "🛍️ Shop",
  "❓ Daily questions",
  "🛡️ Scam protection",
  "📰 ISU feeds",
];

export function bannerPage(): string {
  return `<!doctype html><html><head>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;600;800&display=block" rel="stylesheet">
  <style>
    body { margin: 0; }
    #shot {
      width: 1280px; height: 400px; box-sizing: border-box; padding: 0 88px;
      display: flex; align-items: center; gap: 56px; overflow: hidden; position: relative;
      font-family: "Noto Sans", -apple-system, "Helvetica Neue", Arial, sans-serif;
      background: radial-gradient(circle at 12% 20%, #3b3f8f 0%, transparent 45%),
                  radial-gradient(circle at 90% 90%, #5b3a9e 0%, transparent 40%), #17182b;
      border-radius: 24px;
    }
    #shot::after {
      content: ""; position: absolute; inset: 0;
      background-image: radial-gradient(rgba(255,255,255,.07) 1.5px, transparent 1.5px);
      background-size: 26px 26px; pointer-events: none;
    }
    .logo { width: 200px; height: 200px; flex-shrink: 0; filter: drop-shadow(0 18px 40px rgba(0,0,0,.45)); }
    h1 { margin: 0; color: #fff; font-size: 104px; font-weight: 800; letter-spacing: -3px; line-height: 1; }
    p { margin: 14px 0 26px; color: #c9cdfb; font-size: 28px; }
    .chips { display: flex; flex-wrap: wrap; gap: 10px; max-width: 880px; }
    .chip { background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.14); color: #eef0ff;
            border-radius: 999px; padding: 7px 16px; font-size: 19px; font-weight: 600; }
  </style></head><body>
  <div id="shot">
    <div class="logo">${LOGO_SVG}</div>
    <div>
      <h1>Tuli</h1>
      <p>The friendly Discord bot for our ISU community</p>
      <div class="chips">${FEATURES.map((f) => `<span class="chip">${f}</span>`).join("")}</div>
    </div>
  </div></body></html>`;
}
