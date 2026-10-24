// Renders extension/icons/icon.svg to the PNG sizes the manifest names:
// 16 and 32 for the toolbar, 48 for the extensions page, 128 for the store,
// which Chrome's guidelines want as 96 px of artwork inside 16 px of padding.
// Run: node dev/export-icons.mjs
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

delete process.env.WAYLAND_DISPLAY; // see playwright.config.js
const DIR = new URL("../extension/icons/", import.meta.url).pathname;
const svg = readFileSync(join(DIR, "icon.svg"), "utf8");
const SIZES = { 16: 0, 32: 0, 48: 0, 128: 16 }; // size -> padding in px

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [size, pad] of Object.entries(SIZES).map(([s, p]) => [+s, p])) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;margin:${pad}px;width:${size - 2 * pad}px;height:${size - 2 * pad}px}</style>${svg}`
  );
  await page.screenshot({ path: join(DIR, `icon-${size}.png`), omitBackground: true });
  console.log(`icon-${size}.png`);
}
await browser.close();
