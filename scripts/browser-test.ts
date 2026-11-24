// M1c browser verification against the production build, in the installed Chrome.
// Prereq: npm run build (static export to out/).  Run: npx tsx scripts/browser-test.ts   (HEADED=1 to watch)
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { sceneAt } from "../src/animation";
import { hudAt, pickPlanet } from "../src/hud";
import { OUT_DIR, luminance, makeChecker } from "./lib";

const PORT = 3217;
const BASE_URL = `http://localhost:${PORT}/`;
const READY_TIMEOUT_MS = 30_000;
const CROSSFADE_MS = 600;
const DESKTOP_BREAKPOINT = 1024;
// Poster vs live canvas: mean absolute sRGB difference over the stage. Lossy encoding,
// grain, and resampling account for a few levels; a framing or colour mismatch is far larger.
const POSTER_MATCH_TOLERANCE = 10;

const VIEWPORTS = [
  { width: 360, height: 780, deviceScaleFactor: 2 },
  { width: 768, height: 1024, deviceScaleFactor: 1 },
  // Stage 683 x 768 (aspect 0.89): right at the width-/height-fit switchover.
  { width: 1024, height: 768, deviceScaleFactor: 1 },
  { width: 1280, height: 800, deviceScaleFactor: 1 },
  { width: 1920, height: 1080, deviceScaleFactor: 1 },
] as const;

type Viewport = (typeof VIEWPORTS)[number];

const { failures, check } = makeChecker();

// Serves the static export (out/, exactly what Cloudflare serves) with a tiny node
// server spawned directly, so the PID we kill at the end is the server itself.
function startServer(): ChildProcess {
  const server = fileURLToPath(new URL("./serve-out.mjs", import.meta.url));
  return spawn(process.execPath, [server, String(PORT)], { stdio: "ignore" });
}

async function assertPortFree(): Promise<void> {
  try {
    await fetch(BASE_URL);
  } catch {
    return;
  }
  throw new Error(`Port ${PORT} is already serving; stop that process so the test runs against this build.`);
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(BASE_URL)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`next start did not come up on ${BASE_URL}`);
}

function stopServer(server: ChildProcess): void {
  if (server.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    server.kill("SIGTERM");
  }
}

interface Diagnostics {
  errors: string[];
  warnings: string[];
}

function watchConsole(page: Page): Diagnostics {
  const diagnostics: Diagnostics = { errors: [], warnings: [] };
  page.on("console", (message) => {
    if (message.type() === "error") diagnostics.errors.push(`${message.text()} [${message.location().url}]`);
    if (message.type() === "warning") diagnostics.warnings.push(message.text());
  });
  page.on("pageerror", (error) => diagnostics.errors.push(String(error)));
  page.on("response", (response) => {
    if (response.status() >= 400) diagnostics.errors.push(`HTTP ${response.status()} ${response.url()}`);
  });
  return diagnostics;
}

function decodeScreenshot(buffer: Buffer) {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height, data: png.data };
}

type Image = ReturnType<typeof decodeScreenshot>;

function meanRgb(image: Image, x0: number, y0: number, x1: number, y1: number): [number, number, number] {
  const sum: [number, number, number] = [0, 0, 0];
  let n = 0;
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(image.height, y1); y++) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(image.width, x1); x++) {
      const i = (y * image.width + x) * 4;
      sum[0] += image.data[i]!;
      sum[1] += image.data[i + 1]!;
      sum[2] += image.data[i + 2]!;
      n++;
    }
  }
  return [sum[0] / n, sum[1] / n, sum[2] / n].map(Math.round) as [number, number, number];
}

function medianLuminance(image: Image, x0: number, y0: number, x1: number, y1: number): number {
  const values: number[] = [];
  for (let y = Math.floor(y0); y < y1; y += 2) {
    for (let x = Math.floor(x0); x < x1; x += 2) {
      const i = (y * image.width + x) * 4;
      values.push(luminance(image.data[i]!, image.data[i + 1]!, image.data[i + 2]!));
    }
  }
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)] ?? 0;
}

function meanAbsDiff(a: Image, b: Image, x0: number, y0: number, x1: number, y1: number): number {
  let sum = 0;
  let n = 0;
  for (let y = Math.floor(y0); y < y1; y++) {
    for (let x = Math.floor(x0); x < x1; x++) {
      const i = (y * a.width + x) * 4;
      sum += Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!);
      n += 3;
    }
  }
  return sum / Math.max(1, n);
}

function isIceBlue(r: number, g: number, b: number): boolean {
  return b > r + 25 && g > r && b > 110;
}

// HUD: completed-scan status (with the CTAs), disclaimer, and the ice hotspot sitting on
// revealed ice with its result label fully on screen.
async function checkHud(page: Page, label: string, shot: Image, scale: number): Promise<void> {
  const hud = await page.evaluate(() => {
    const ice = document.querySelector('[data-hotspot="ice"]') as HTMLElement | null;
    const rect = ice?.getBoundingClientRect();
    const status = document.querySelector('[role="status"]');
    const iceLabel = ice?.lastElementChild?.getBoundingClientRect();
    return {
      phase: document.querySelector("section")!.getAttribute("data-scan-phase"),
      status: status?.textContent ?? "",
      live: status?.getAttribute("aria-live"),
      statusWithCtas: !!status && !!status.closest("section")?.querySelector('[data-cta="scan"]') &&
        status.compareDocumentPosition(document.querySelector('[data-cta="scan"]')!) === Node.DOCUMENT_POSITION_PRECEDING,
      disclaimer: document.body.innerText.toLowerCase().includes("not live data"),
      iceVisible: ice?.dataset.visible === "true",
      iceLabelText: ice?.lastElementChild?.textContent ?? "",
      labelInside: !!iceLabel && iceLabel.left >= 0 && iceLabel.right <= window.innerWidth && iceLabel.top >= 0,
      x: rect ? rect.left + rect.width / 2 : -1,
      y: rect ? rect.top + rect.height / 2 : -1,
    };
  });
  check(hud.phase === "complete" && hud.status === "Subsurface ice indicated" && hud.live === "polite", `${label}: radar result announced ("${hud.status}", aria-live=${hud.live})`);
  check(hud.statusWithCtas, `${label}: scan status sits with the scan CTA (after it in the copy)`);
  check(hud.disclaimer, `${label}: labelled as conceptual telemetry, not live data`);
  check(hud.iceLabelText.includes("conceptual") && hud.labelInside, `${label}: ice result label on the planet, fully on screen ("${hud.iceLabelText}")`);
  let blue = 0;
  const cx = Math.round(hud.x * scale);
  const cy = Math.round(hud.y * scale);
  const half = Math.round(4 * scale);
  for (let y = cy - half; y <= cy + half; y++) {
    for (let x = cx - half; x <= cx + half; x++) {
      const i = (y * shot.width + x) * 4;
      if (isIceBlue(shot.data[i]!, shot.data[i + 1]!, shot.data[i + 2]!)) blue++;
    }
  }
  const total = (2 * half + 1) ** 2;
  check(hud.iceVisible && blue > total * 0.4, `${label}: ice hotspot visible on revealed ice (${blue}/${total} px ice-blue under it)`);
}

// Header placement and stars behind the copy (the page is starry edge to edge).
async function checkLayout(page: Page, label: string, shot: Image, scale: number): Promise<void> {
  const layout = await page.evaluate(() => {
    const brand = document.querySelector("header p")!.getBoundingClientRect();
    const scan = document.querySelector('[data-cta="scan"]')!.getBoundingClientRect();
    const copy = document.querySelector("h1")!.parentElement!.getBoundingClientRect();
    return {
      brand: { left: brand.left, top: brand.top },
      scan: { right: scan.right, top: scan.top },
      width: window.innerWidth,
      copyBottom: copy.bottom,
      copyLeft: copy.left,
      copyRight: copy.right,
      height: window.innerHeight,
    };
  });
  check(layout.brand.left < 72 && layout.brand.top < 40, `${label}: SkyFall logo + line at the top-left (${Math.round(layout.brand.left)}, ${Math.round(layout.brand.top)})`);
  check(layout.width - layout.scan.right < 72 && layout.scan.top < 40, `${label}: "Initiate radar scan" at the top-right (${Math.round(layout.width - layout.scan.right)} px from the edge)`);
  // Count star pixels in the empty band below the copy text, inside the copy column.
  const y0 = Math.round(Math.min(layout.copyBottom + 8, layout.height - 40) * scale);
  const y1 = Math.round(layout.height * scale) - 4;
  const x0 = Math.round(layout.copyLeft * scale);
  const x1 = Math.round(Math.min(layout.copyRight, layout.width) * scale);
  let stars = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * shot.width + x) * 4;
      if (luminance(shot.data[i]!, shot.data[i + 1]!, shot.data[i + 2]!) > 30) stars++;
    }
  }
  check(stars >= 3, `${label}: stars behind the copy too (${stars} star px below the text)`);
}

async function stageRect(page: Page) {
  return page.$eval('[role="img"]', (element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  });
}

async function openHero(context: BrowserContext, path = BASE_URL) {
  const page = await context.newPage();
  const diagnostics = watchConsole(page);
  await page.goto(path, { waitUntil: "load" });
  return { page, diagnostics };
}

async function waitForState(page: Page, state: string): Promise<boolean> {
  try {
    await page.waitForSelector(`[data-render-state="${state}"]`, { timeout: READY_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

function reportConsole(label: string, diagnostics: Diagnostics): void {
  const gpuWarnings = diagnostics.warnings.filter((text) => /gpu|wgsl|shader|vgpu/i.test(text));
  check(
    diagnostics.errors.length === 0 && gpuWarnings.length === 0,
    `${label}: no console errors or WebGPU warnings` +
      (diagnostics.errors.length + gpuWarnings.length > 0
        ? ` -> ${[...diagnostics.errors, ...gpuWarnings].join(" | ").slice(0, 400)}`
        : "")
  );
}

async function testViewport(browser: Browser, viewport: Viewport): Promise<void> {
  const label = `${viewport.width}x${viewport.height}@${viewport.deviceScaleFactor}x`;
  // Reduced motion renders the settled composition, which is exactly what the poster
  // shows, so layout, pixels, and poster-vs-canvas can be compared deterministically.
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: viewport.deviceScaleFactor, reducedMotion: "reduce" });
  try {
    const { page, diagnostics } = await openHero(context);
    const ready = await waitForState(page, "webgpu");
    check(ready, `${label}: WebGPU canvas initialized (data-render-state=webgpu)`);
    if (!ready) {
      const state = await page.getAttribute("section", "data-render-state");
      console.log(`      state is "${state}"; console: ${diagnostics.errors.concat(diagnostics.warnings).join(" | ").slice(0, 400)}`);
      return;
    }
    await page.waitForTimeout(CROSSFADE_MS + 200);
    const live = decodeScreenshot(await page.screenshot({ path: `${OUT_DIR}m1c-browser-${viewport.width}.png` }));

    const stage = await stageRect(page);
    const layout = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      canvas: (() => {
        const canvas = document.querySelector("canvas")!;
        const rect = canvas.getBoundingClientRect();
        return { width: canvas.width, height: canvas.height, cssWidth: rect.width, cssHeight: rect.height, opacity: getComputedStyle(canvas).opacity };
      })(),
    }));
    check(layout.scrollWidth <= layout.innerWidth, `${label}: no horizontal scroll (${layout.scrollWidth} <= ${layout.innerWidth})`);
    if (viewport.width >= DESKTOP_BREAKPOINT) {
      check(Math.abs(stage.left - viewport.width / 3) <= 2 && Math.abs(stage.width - (viewport.width * 2) / 3) <= 2, `${label}: Mars stage occupies the right two-thirds (left ${stage.left.toFixed(0)}, width ${stage.width.toFixed(0)})`);
    } else {
      check(stage.left === 0 && Math.abs(stage.width - viewport.width) <= 1, `${label}: Mars stage spans the full width on narrow screens`);
    }
    const expectedDpr = Math.min(2, viewport.deviceScaleFactor);
    check(
      Math.abs(layout.canvas.width - layout.canvas.cssWidth * expectedDpr) <= 2 && Math.abs(layout.canvas.height - layout.canvas.cssHeight * expectedDpr) <= 2,
      `${label}: canvas backing store matches CSS size x DPR ${expectedDpr} (${layout.canvas.width}x${layout.canvas.height})`
    );
    check(layout.canvas.opacity === "1", `${label}: canvas faded in (opacity ${layout.canvas.opacity})`);

    // Pixels: rust-red at the planet's lit centre, dark sky in the corners of the stage.
    const scale = viewport.deviceScaleFactor;
    const cx = (stage.left + stage.width / 2) * scale;
    const cy = (stage.top + stage.height / 2) * scale;
    const box = 12 * scale;
    const centre = meanRgb(live, cx - box - 40 * scale, cy - box, cx + box - 40 * scale, cy + box);
    check(centre[0] > centre[1] * 1.6 && centre[1] > centre[2] && centre[0] > 90, `${label}: live pixels at the lit planet are rust-red (rgb ${centre.join(",")})`);
    const sky = medianLuminance(live, stage.left * scale, 0, (stage.left + stage.width) * scale, 40 * scale);
    check(sky < 12, `${label}: sky above the planet is deep space (median luminance ${sky.toFixed(1)})`);
    if (viewport.width >= DESKTOP_BREAKPOINT) {
      const copyArea = medianLuminance(live, 0, 0, stage.left * scale, live.height);
      check(copyArea < 12, `${label}: left third stays dark for copy (median luminance ${copyArea.toFixed(1)})`);
      // No seam: the rendered sky just inside the stage edge matches the page background.
      const edgeX = stage.left * scale;
      const outside = medianLuminance(live, edgeX - 40 * scale, 0, edgeX - 4 * scale, live.height);
      const inside = medianLuminance(live, edgeX + 4 * scale, 0, edgeX + 40 * scale, live.height);
      check(Math.abs(outside - inside) <= 1.5, `${label}: no seam at the stage edge (page ${outside.toFixed(1)} vs sky ${inside.toFixed(1)})`);
    }

    await checkHud(page, label, live, scale);
    await checkLayout(page, label, live, scale);

    // The poster must match the live frame so the cross-fade does not jump.
    await page.evaluate(() => {
      document.querySelector("canvas")!.style.visibility = "hidden";
    });
    const poster = decodeScreenshot(await page.screenshot());
    const diff = meanAbsDiff(live, poster, stage.left * scale, stage.top * scale, (stage.left + stage.width) * scale, (stage.top + stage.height) * scale);
    check(diff < POSTER_MATCH_TOLERANCE, `${label}: poster matches the live render (mean abs diff ${diff.toFixed(2)})`);

    reportConsole(label, diagnostics);
  } finally {
    await context.close();
  }
}

async function testFallback(browser: Browser, label: string, initScript: string, viewport: { width: number; height: number }, expectPortrait: boolean): Promise<void> {
  const context = await browser.newContext({ viewport });
  try {
    await context.addInitScript(initScript);
    const { page, diagnostics } = await openHero(context);
    const fellBack = await waitForState(page, "fallback");
    check(fellBack, `${label}: falls back (data-render-state=fallback)`);
    await page.waitForFunction(() => {
      const img = document.querySelector("img");
      return !!img && img.complete && img.naturalWidth > 0;
    });
    const info = await page.evaluate(() => {
      const img = document.querySelector("img")!;
      return { currentSrc: img.currentSrc, opacity: getComputedStyle(document.querySelector("canvas")!).opacity };
    });
    check(info.opacity === "0", `${label}: canvas stays hidden`);
    check(info.currentSrc.includes(expectPortrait ? "portrait" : "landscape"), `${label}: serves the ${expectPortrait ? "portrait" : "landscape"} poster (${info.currentSrc.split("/").pop()})`);
    const shot = decodeScreenshot(await page.screenshot({ path: `${OUT_DIR}m1c-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png` }));
    const stage = await stageRect(page);
    const cx = stage.left + stage.width / 2;
    const cy = stage.top + stage.height / 2;
    const centre = meanRgb(shot, cx - 52, cy - 12, cx - 28, cy + 12);
    check(centre[0] > centre[1] * 1.6 && centre[0] > 90, `${label}: poster shows rust-red Mars (rgb ${centre.join(",")})`);
    await checkHud(page, label, shot, 1);
    await checkLayout(page, label, shot, 1);
    reportConsole(label, diagnostics);
  } finally {
    await context.close();
  }
}

function canvasDiff(a: Image, b: Image): number {
  return meanAbsDiff(a, b, 0, 0, a.width, a.height);
}

// Motion allowed: the intro animates in real time. Reduced: the canvas never changes.
const MOTION_SAMPLE_GAP_MS = 1500;
async function testMotion(browser: Browser): Promise<void> {
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion });
    try {
      const { page, diagnostics } = await openHero(context);
      await waitForState(page, "webgpu");
      await page.waitForTimeout(CROSSFADE_MS + 200);
      const canvas = page.locator("canvas");
      const first = decodeScreenshot(await canvas.screenshot());
      await page.waitForTimeout(MOTION_SAMPLE_GAP_MS);
      const second = decodeScreenshot(await canvas.screenshot());
      const diff = canvasDiff(first, second);
      if (reducedMotion === "reduce") {
        check(diff === 0, `reduced-motion=reduce: canvas is perfectly still over ${MOTION_SAMPLE_GAP_MS} ms (mean diff ${diff.toFixed(3)})`);
      } else {
        check(diff > 1, `reduced-motion=no-preference: intro animates in real time (mean diff ${diff.toFixed(2)} over ${MOTION_SAMPLE_GAP_MS} ms)`);
      }
      reportConsole(`motion ${reducedMotion}`, diagnostics);
    } finally {
      await context.close();
    }
  }
}

// Real time, motion allowed: the radar scan runs by itself after the intro settles.
const SCAN_TIMEOUT_MS = 25_000;
async function testScanSequence(browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "no-preference" });
  try {
    const { page, diagnostics } = await openHero(context);
    await waitForState(page, "webgpu");
    const phases: string[] = [];
    const deadline = Date.now() + SCAN_TIMEOUT_MS;
    let midScan: Image | undefined;
    while (Date.now() < deadline) {
      const phase = (await page.getAttribute("section", "data-scan-phase")) ?? "";
      if (phases.at(-1) !== phase) phases.push(phase);
      if (phase === "scanning" && !midScan) {
        await page.waitForTimeout(1200);
        midScan = decodeScreenshot(await page.screenshot({ path: `${OUT_DIR}m3-browser-scanning-1280.png` }));
      }
      if (phase === "complete") break;
      await page.waitForTimeout(200);
    }
    check(phases.join(" > ") === "idle > scanning > complete", `scan runs by itself after the intro (${phases.join(" > ")})`);
    const status = await page.textContent('[role="status"]');
    check(status === "Subsurface ice indicated", `scan completes with the result announced ("${status}")`);
    await page.waitForTimeout(600);
    const done = decodeScreenshot(await page.screenshot({ path: `${OUT_DIR}m3-browser-complete-1280.png` }));
    await checkHud(page, "live scan 1280", done, 1);
    reportConsole("live scan 1280", diagnostics);
  } finally {
    await context.close();
  }
}

// --- M4: copy, CTAs, keyboard, contrast, mission reveal, frame rate -------------------

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const lum = (rgb: [number, number, number]) => 0.2126 * srgbToLinear(rgb[0]) + 0.7152 * srgbToLinear(rgb[1]) + 0.0722 * srgbToLinear(rgb[2]);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const SPACE_RGB: [number, number, number] = [5, 6, 10];

function parseRgb(css: string): number[] {
  return (css.match(/[0-9.]+/g) ?? []).map(Number);
}

async function testCopyKeyboardAndContrast(browser: Browser): Promise<void> {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 360, height: 780 }]) {
    const label = `copy ${viewport.width}`;
    const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
    try {
      const { page, diagnostics } = await openHero(context);
      await waitForState(page, "webgpu");
      const copy = await page.evaluate(() => ({
        h1: document.querySelector("h1")?.textContent,
        h1Visible: (() => {
          const r = document.querySelector("h1")!.getBoundingClientRect();
          return r.top < window.innerHeight && r.bottom > 0 && r.left >= 0 && r.right <= window.innerWidth;
        })(),
        scan: document.querySelector('[data-cta="scan"]')?.textContent,
        explore: document.querySelector('[data-cta="explore"]')?.textContent,
        sections: document.querySelectorAll("section").length,
        pageHeight: document.documentElement.scrollHeight,
      }));
      check(copy.h1 === "Beneath the Red, a Future Awaits." && copy.h1Visible, `${label}: headline visible above the fold`);
      check(copy.scan === "Initiate radar scan" && copy.explore === "Explore Mars", `${label}: both CTAs present ("${copy.scan}", "${copy.explore}")`);
      check(copy.sections === 1, `${label}: one fold only (${copy.sections} section)`);

      // Contrast of every hero text style against the background it sits on.
      const styles = await page.evaluate(() =>
        ["h1", ".copy p, section p", '[data-cta="scan"]', '[data-cta="explore"]', "section dt", "section dd", '[role="status"]'].map((selector) => {
          const element = document.querySelector(selector)!;
          return { selector, color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor };
        })
      );
      for (const style of styles) {
        const fg = parseRgb(style.color);
        const bg = parseRgb(style.background);
        const background: [number, number, number] = bg.length === 4 && bg[3] === 0 ? SPACE_RGB : [bg[0]!, bg[1]!, bg[2]!];
        const ratio = contrastRatio([fg[0]!, fg[1]!, fg[2]!], background);
        check(ratio >= 4.5, `${label}: ${style.selector} contrast ${ratio.toFixed(1)}:1 (>= 4.5)`);
      }

      // Keyboard: Tab reaches the scan CTA, then Explore Mars; Explore focuses the first
      // hotspot; Enter opens its card; Esc closes it and returns focus.
      await page.keyboard.press("Tab");
      const first = await page.evaluate(() => document.activeElement?.getAttribute("data-cta"));
      await page.keyboard.press("Tab");
      const second = await page.evaluate(() => document.activeElement?.getAttribute("data-cta"));
      check(first === "scan" && second === "explore", `${label}: Tab order reaches both CTAs first (${first}, ${second})`);
      const focusRing = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
      check(focusRing !== "none", `${label}: focused CTA shows a focus ring (${focusRing})`);
      await page.keyboard.press("Enter");
      const explored = await page.evaluate(() => ({
        revealed: document.querySelector("[data-revealed]")?.getAttribute("data-revealed"),
        focused: document.activeElement?.getAttribute("data-hotspot"),
        labels: [...document.querySelectorAll("[data-hotspot]")].filter((b) => (b as HTMLElement).dataset.visible === "true").length,
      }));
      const offscreen = await page.evaluate(() =>
        [...document.querySelectorAll("[data-hotspot]")]
          .filter((b) => (b as HTMLElement).dataset.visible === "true")
          .flatMap((b) => [b.firstElementChild!, b.lastElementChild!])
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.left < 0 || r.right > window.innerWidth || r.top < 0;
          }).length
      );
      check(offscreen === 0, `${label}: every revealed hotspot and label is fully on screen (${offscreen} clipped)`);
      check(explored.revealed === "true" && explored.focused === "entry" && explored.labels === 4, `${label}: Explore Mars reveals all ${explored.labels} hotspots and focuses the first (${explored.focused})`);
      await page.keyboard.press("Tab");
      const nextHotspot = await page.evaluate(() => document.activeElement?.getAttribute("data-hotspot"));
      check(nextHotspot === "helicopters", `${label}: Tab moves through the hotspots in story order (${nextHotspot})`);
      await page.keyboard.press("Enter");
      const card = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const rect = dialog?.getBoundingClientRect();
        return {
          title: dialog?.querySelector("h2")?.textContent,
          focusInCard: !!dialog && dialog.contains(document.activeElement),
          expanded: document.querySelector('[data-hotspot="helicopters"]')?.getAttribute("aria-expanded"),
          inside: !!rect && rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight,
          width: rect?.width ?? 0,
          concept: dialog?.textContent?.includes("not live data") ?? false,
        };
      });
      check(card.title === "Three autonomous helicopters" && card.focusInCard && card.expanded === "true", `${label}: Enter opens the hotspot's card ("${card.title}", focus moved in)`);
      check(card.inside && card.concept, `${label}: card fully on screen (${Math.round(card.width)} px wide) and labelled conceptual`);
      const labelsShowing = await page.evaluate(() =>
        // button[...]: the open card carries data-hotspot too.
        [...document.querySelectorAll("button[data-hotspot]")].filter((b) => Number(getComputedStyle(b.lastElementChild!).opacity) > 0.01).length
      );
      check(labelsShowing === 0, `${label}: hotspot labels step back while a card is open (${labelsShowing} showing)`);
      await page.screenshot({ path: `${OUT_DIR}interact-card-${viewport.width}.png` });
      await page.keyboard.press("Escape");
      const closed = await page.evaluate(() => ({
        open: !!document.querySelector('[role="dialog"]'),
        focused: document.activeElement?.getAttribute("data-hotspot"),
      }));
      check(!closed.open && closed.focused === "helicopters", `${label}: Esc closes the card and returns focus to its hotspot (${closed.focused})`);

      // Reduced motion: the scan CTA replays the result in text; nothing moves.
      await page.focus('[data-cta="scan"]');
      await page.keyboard.press("Enter");
      const replay: string[] = [];
      for (let i = 0; i < 12; i++) {
        const status = (await page.textContent('[role="status"]')) ?? "";
        if (replay.at(-1) !== status) replay.push(status);
        await page.waitForTimeout(150);
      }
      check(
        replay.join(" > ") === "Radar sweep · 0.5–3 m below the surface > Subsurface ice indicated",
        `${label}: reduced-motion scan CTA re-announces the result (${replay.join(" > ")})`
      );
      await page.screenshot({ path: `${OUT_DIR}interact-${viewport.width}.png`, fullPage: true });
      reportConsole(label, diagnostics);
    } finally {
      await context.close();
    }
  }
}

// Canvas interaction (reduced motion, so positions are deterministic): clicking a
// helicopter opens its card, clicking the planet pings it, dragging turns Mars, and the
// view returns to the composed shot after the idle timeout.
const IDLE_RETURN_WAIT_MS = 7000;
async function testCanvasInteraction(browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  try {
    const { page, diagnostics } = await openHero(context);
    await waitForState(page, "webgpu");
    const stage = await stageRect(page);
    const aspect = stage.width / stage.height;
    const state = sceneAt(0, { aspect, reducedMotion: true });
    const toPage = (x: number, y: number) => [stage.left + x * stage.width, stage.top + y * stage.height] as const;

    // Helicopter B has no DOM button: only the canvas hit test can open its card.
    const b = hudAt(state, aspect).helicopters[1]!;
    await page.mouse.click(...toPage(b.x, b.y));
    const heliCard = await page.textContent('[role="dialog"] h2').catch(() => null);
    check(heliCard === "Three autonomous helicopters", `clicking a helicopter on the canvas opens its card ("${heliCard}")`);
    await page.keyboard.press("Escape");

    // Ping a planet point away from every hotspot.
    const pingPoint = [0.55, 0.42] as const;
    check(pickPlanet(state, aspect, ...pingPoint) !== null, "ping target is on the planet");
    await page.mouse.click(...toPage(...pingPoint));
    await page.waitForTimeout(250);
    const ping = await page.evaluate(() => ({
      readout: (document.querySelector('[data-visible] > span') as HTMLElement | null)?.closest("[data-visible]")?.getAttribute("data-visible"),
      text: [...document.querySelectorAll("p[aria-live]")].map((p) => p.textContent).join(" | "),
      dialog: !!document.querySelector('[role="dialog"]'),
    }));
    check(/Radar return · (ice likely|ice possible|no ice detected), conceptual\./.test(ping.text) && !ping.dialog, `clicking Mars pings it and announces the reading ("${ping.text.split(" | ").find((t) => t?.startsWith("Radar return")) ?? ""}")`);
    await page.screenshot({ path: `${OUT_DIR}interact-ping-1280.png` });
    await page.waitForTimeout(3000);

    // Drag: canyon hotspot moves; no ping from a drag.
    const canyonAt = () =>
      page.$eval('[data-hotspot="canyon"]', (el) => {
        const r = el.getBoundingClientRect();
        return [r.left + r.width / 2, r.top + r.height / 2] as const;
      });
    const before = await canyonAt();
    const [sx, sy] = toPage(0.5, 0.5);
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(sx + i * 20, sy);
    await page.mouse.up();
    await page.waitForTimeout(200);
    const after = await canyonAt();
    const moved = Math.hypot(after[0] - before[0], after[1] - before[1]);
    const pingAfterDrag = await page.evaluate(() => [...document.querySelectorAll("p[aria-live]")].some((p) => p.textContent?.startsWith("Radar return")));
    check(moved > 40 && !pingAfterDrag, `dragging turns Mars (canyon hotspot moved ${moved.toFixed(0)} px; no ping from a drag)`);
    await page.waitForTimeout(IDLE_RETURN_WAIT_MS);
    const returned = await canyonAt();
    const offset = Math.hypot(returned[0] - before[0], returned[1] - before[1]);
    check(offset < 2, `view returns to the composed shot after ${IDLE_RETURN_WAIT_MS / 1000 - 1}s idle (${offset.toFixed(1)} px from start)`);
    reportConsole("canvas interaction", diagnostics);
  } finally {
    await context.close();
  }
}

// Motion allowed: after the auto scan, the CTA runs a real sweep; frame rate is measured
// while it runs; a click on Mars then draws a ping ring on the live canvas.
const MIN_SCAN_FPS = 50;
async function testScanCtaAndReveal(browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "no-preference" });
  try {
    const { page, diagnostics } = await openHero(context);
    await waitForState(page, "webgpu");
    await page.waitForSelector('section[data-scan-phase="complete"]', { timeout: SCAN_TIMEOUT_MS });
    await page.click('[data-cta="scan"]');
    const started = await page.waitForSelector('section[data-scan-phase="scanning"]', { timeout: 2000 }).then(() => true, () => false);
    const busyLabel = await page.textContent('[data-cta="scan"]');
    check(started && busyLabel === "Scanning…", `scan CTA starts a new radar sweep (button shows "${busyLabel}")`);
    // A string, not a callback: tsx would wrap the inner named function in an __name()
    // helper that does not exist in the page.
    const fps = (await page.evaluate(`new Promise((resolve) => {
      let frames = 0;
      const start = performance.now();
      const tick = (now) => {
        frames++;
        if (now - start < 1000) requestAnimationFrame(tick);
        else resolve((frames * 1000) / (now - start));
      };
      requestAnimationFrame(tick);
    })`)) as number;
    check(fps >= MIN_SCAN_FPS, `frame rate during the radar sweep: ${fps.toFixed(0)} fps (>= ${MIN_SCAN_FPS})`);
    await page.waitForSelector('section[data-scan-phase="complete"]', { timeout: 6000 });
    check((await page.textContent('[data-cta="scan"]')) === "Initiate radar scan", "scan CTA is ready again after the sweep");

    const stage = await stageRect(page);
    const canvas = page.locator("canvas");
    const quiet = decodeScreenshot(await canvas.screenshot());
    await page.mouse.click(stage.left + 0.55 * stage.width, stage.top + 0.42 * stage.height);
    await page.waitForTimeout(450);
    const ringing = decodeScreenshot(await canvas.screenshot());
    const diff = canvasDiff(quiet, ringing);
    check(diff > 1, `a click on Mars draws a live ping ring (mean canvas diff ${diff.toFixed(2)})`);
    reportConsole("scan CTA + ping", diagnostics);
  } finally {
    await context.close();
  }
}

async function testReducedMotion(browser: Browser): Promise<void> {
  for (const reducedMotion of ["reduce", "no-preference"] as const) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion });
    try {
      const { page, diagnostics } = await openHero(context);
      await waitForState(page, "webgpu");
      const info = await page.evaluate(() => ({
        attribute: document.querySelector("section")!.getAttribute("data-reduced-motion"),
        transition: getComputedStyle(document.querySelector("canvas")!).transitionDuration,
      }));
      const reduce = reducedMotion === "reduce";
      check(info.attribute === String(reduce), `reduced-motion=${reducedMotion}: component sees preference (data-reduced-motion=${info.attribute})`);
      check(reduce ? info.transition === "0s" : info.transition === "0.6s", `reduced-motion=${reducedMotion}: cross-fade ${reduce ? "disabled" : "enabled"} (transition ${info.transition})`);
      reportConsole(`reduced-motion=${reducedMotion}`, diagnostics);
    } finally {
      await context.close();
    }
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  await assertPortFree();
  const server = startServer();
  let browser: Browser | undefined;
  try {
    await waitForServer();
    browser = await chromium.launch({ channel: "chrome", headless: process.env.HEADED !== "1" });
    console.log(`Chrome ${browser.version()}`);
    for (const viewport of VIEWPORTS) await testViewport(browser, viewport);
    await testFallback(browser, "fallback no-navigator-gpu 1280", "Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true });", { width: 1280, height: 800 }, false);
    await testFallback(browser, "fallback no-adapter 360", "if (navigator.gpu) { navigator.gpu.requestAdapter = async () => null; }", { width: 360, height: 780 }, true);
    await testReducedMotion(browser);
    await testMotion(browser);
    await testScanSequence(browser);
    await testCopyKeyboardAndContrast(browser);
    await testScanCtaAndReveal(browser);
    await testCanvasInteraction(browser);
  } finally {
    await browser?.close();
    stopServer(server);
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nM1c browser verification passed");
}

await main();
