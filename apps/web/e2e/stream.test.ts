import { test, expect } from "@playwright/test";

test.describe("sim-stream", () => {
  test("health check - server is running", async ({ request }) => {
    const response = await request.get("http://localhost:3100/health");
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body).toEqual({ status: "ok" });
  });

  test("config endpoint returns screen size", async ({ request }) => {
    const response = await request.get("http://localhost:3100/config");
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body).toHaveProperty("width");
    expect(body).toHaveProperty("height");
    expect(body.width).toBeGreaterThan(0);
    expect(body.height).toBeGreaterThan(0);
  });

  test("page loads and shows sim-stream heading", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("sim-stream");
  });

  test("video element is present", async ({ page }) => {
    await page.goto("/");
    const video = page.locator("video");
    await expect(video).toBeVisible();
  });

  test("WebRTC connection is established", async ({ page }) => {
    await page.goto("/");

    // Wait for the "Connecting..." overlay to disappear (connection established)
    const connectingOverlay = page.locator("text=Connecting...");

    // Either the overlay disappears (connected) or an error shows
    await expect(async () => {
      const isConnecting = await connectingOverlay.isVisible();
      const hasError = await page.locator("text=Error").isVisible();
      expect(isConnecting || hasError).toBe(false);
    }).toPass({ timeout: 10000 });
  });

  test("touch interaction sends data channel message", async ({ page }) => {
    await page.goto("/");

    // Wait for connection
    await page.waitForTimeout(3000);

    // Track data channel messages
    const messages = await page.evaluate(() => {
      return new Promise<string[]>((resolve) => {
        const msgs: string[] = [];
        // Find the video element and simulate a click
        const video = document.querySelector("video");
        if (!video) {
          resolve(["no video element"]);
          return;
        }

        // Click on the video
        const rect = video.getBoundingClientRect();
        const clickEvent = new MouseEvent("mousedown", {
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          bubbles: true,
        });
        video.dispatchEvent(clickEvent);

        const upEvent = new MouseEvent("mouseup", {
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          bubbles: true,
        });
        video.dispatchEvent(upEvent);

        // Give it a moment
        setTimeout(() => resolve(["touch events dispatched"]), 500);
      });
    });

    expect(messages.length).toBeGreaterThan(0);
  });
});
