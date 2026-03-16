import { test, expect } from "@playwright/test";

test("debug WebRTC connection", async ({ page }) => {
  // Collect all console messages
  const logs: string[] = [];
  page.on("console", (msg) => {
    logs.push(`[${msg.type()}] ${msg.text()}`);
  });

  // Collect network errors
  page.on("requestfailed", (req) => {
    logs.push(`[NET FAIL] ${req.url()} ${req.failure()?.errorText}`);
  });

  // Intercept the /offer response
  page.on("response", async (resp) => {
    if (resp.url().includes("/offer")) {
      const status = resp.status();
      let body = "";
      try {
        body = await resp.text();
      } catch {}
      logs.push(`[OFFER RESP] status=${status} body=${body.substring(0, 500)}`);
    }
  });

  await page.goto("http://localhost:5173/");
  await page.waitForTimeout(5000);

  console.log("\n=== BROWSER LOGS ===");
  for (const log of logs) {
    console.log(log);
  }

  // Check for errors
  const errors = logs.filter(
    (l) => l.includes("error") || l.includes("Error") || l.includes("FAIL"),
  );
  if (errors.length > 0) {
    console.log("\n=== ERRORS ===");
    for (const e of errors) console.log(e);
  }
});
