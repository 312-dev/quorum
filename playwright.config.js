import { defineConfig } from "@playwright/test";

// Under WSLg, a set WAYLAND_DISPLAY stops headless Chromium from ever producing
// a compositor frame: requestAnimationFrame, IntersectionObserver and
// Playwright's own click-stability checks all hang. Workers inherit this env.
delete process.env.WAYLAND_DISPLAY;

export default defineConfig({
  testDir: "tests",
  timeout: 60e3,
  workers: 1,
  reporter: [["list"]],
});
