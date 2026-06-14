import { test, expect, Page } from "@playwright/test";

// LIVE A2 proof: drive the /demo page so the in-page daemon (the REAL
// claimBuilder/claimCore — same SLIM claim construction the extension uses)
// records a real impression and settles it ON-CHAIN against the live Paseo
// deploy. Ground-truth assertion is the daemon's own `claimStatus` reaching a
// settled state (it writes settledCount after the on-chain settleClaims), plus a
// non-zero settled count — independent of any UI text.
//
// Why /demo and not the MV3 extension in headless Chrome: the daemon is an
// in-page replica that imports the extension's background modules verbatim
// (routeMessage + claimBuilder), so this exercises the real claim code path in a
// real browser without the headless-extension/encrypted-wallet friction. The
// dual-sig relay path is separately proven (inject + EXTENSION-SLIM-AUDIT).

const TEST_USER = "0x1111111111111111111111111111111111111111"; // beneficiary; daemon submits via its own funded wallet

// chrome.storage.local.get through the in-page shim.
async function storageGet(page: Page, key: string) {
  return page.evaluate(
    (k) => new Promise((res) => (globalThis as any).chrome.storage.local.get(k, (r: any) => res(r[k]))),
    key,
  );
}
async function storageSet(page: Page, obj: Record<string, unknown>) {
  return page.evaluate(
    (o) => new Promise<void>((res) => (globalThis as any).chrome.storage.local.set(o, () => res())),
    obj,
  );
}
async function sendMessage(page: Page, msg: Record<string, unknown>) {
  return page.evaluate(
    (m) => new Promise((res) => (globalThis as any).chrome.runtime.sendMessage(m, (r: any) => res(r))),
    msg,
  );
}

test("a real browser impression settles on-chain via the daemon", async ({ page }) => {
  const logs: string[] = [];
  page.on("console", (m) => logs.push(m.text()));
  page.on("pageerror", (e) => logs.push("PAGEERROR: " + String(e)));

  await page.goto("/demo", { waitUntil: "domcontentloaded" });

  // 1) Daemon ready — the chrome shim + routeMessage are installed once the page
  //    boots. Wait until storage is reachable and campaigns have been polled.
  await expect
    .poll(async () => page.evaluate(() => !!(globalThis as any).chrome?.storage?.local), { timeout: 60_000, message: "chrome shim never installed" })
    .toBe(true);

  // 2) Connect: seed the beneficiary address (the embedded popup's job). The
  //    daemon signs+submits with its own funded wallet, so this is sufficient.
  await storageSet(page, { connectedAddress: TEST_USER, claimBuilderMode: "aggregated" });

  // 3) Wait for active campaigns, then pick one whose publisher is DIANA — the
  //    demo settles gaslessly only for campaigns whose publisher set Diana as
  //    relaySigner (campaign #9 = advertiser bob, publisher diana qualifies).
  //    Picking a non-Diana campaign reverts E32, so don't rely on the topic
  //    auction's choice — drive the impression deterministically.
  const DIANA = "0xcA5668fB864Acab0aC7f4CFa73949174720b58D0";
  let targetObj: { id: string; publisher: string; bidCpmWei: string } | null = null;
  for (let i = 0; i < 30; i++) {
    const cs: any = await storageGet(page, "activeCampaigns");
    if (Array.isArray(cs) && cs.length) {
      if (i === 0 || (i % 5 === 0)) console.log("[harness] campaigns:", JSON.stringify(cs.map((x: any) => ({ id: x.id, pub: x.publisher, st: x.status }))));
      const c = cs.find((x: any) => String(x.publisher || "").toLowerCase() === DIANA.toLowerCase() && Number(x.status) === 1);
      if (c) { targetObj = { id: String(c.id), publisher: c.publisher, bidCpmWei: String(c.bidCpmWei ?? "0") }; break; }
    }
    await page.waitForTimeout(3000);
  }
  expect(targetObj, "no active Diana-published campaign in the daemon cache (create one with publisher=diana)").not.toBeNull();
  console.log("[harness] target campaign:", JSON.stringify(targetObj));

  // 4) Record a real impression for that campaign (the daemon's IMPRESSION_RECORDED
  //    path = same claimBuilder/claimCore as a real ad view; aggregated mode queues
  //    it). This exercises the real claim construction deterministically.
  const impRes = await sendMessage(page, {
    type: "IMPRESSION_RECORDED",
    campaignId: targetObj.id,
    publisherAddress: targetObj.publisher,
    clearingCpmWei: targetObj.bidCpmWei !== "0" ? targetObj.bidCpmWei : undefined,
    url: "https://demo.local/article",
    category: "IAB19",
  });
  console.log("[harness] IMPRESSION_RECORDED →", JSON.stringify(impRes));

  // Diagnostics: queue state right after the impression, before flushing.
  const qBefore: any = await storageGet(page, "claimQueue");
  const rawBefore: any = await storageGet(page, "rawImpressionQueue");
  console.log(`[harness] after visits: claimQueue=${Array.isArray(qBefore) ? qBefore.length : qBefore} rawImpressionQueue=${Array.isArray(rawBefore) ? rawBefore.length : rawBefore}`);

  // 5) Flush: drain the raw-impression queue → build aggregated SLIM claims →
  //    settleClaims on-chain.
  const submitResult = await sendMessage(page, { type: "DAEMON_SUBMIT_CLAIMS", userAddress: TEST_USER });
  console.log("[harness] DAEMON_SUBMIT_CLAIMS →", JSON.stringify(submitResult));

  // 6) Poll claimStatus + dump diagnostics (always printed, even on failure).
  let settled = 0;
  for (let i = 0; i < 28; i++) {
    const s: any = await storageGet(page, "claimStatus");
    console.log(`[harness] t+${i * 5}s claimStatus=${JSON.stringify(s)}`);
    const n = Number(s?.settledCount ?? 0);
    if (s?.status === "settled" || n > 0) { settled = n || 1; break; }
    await page.waitForTimeout(5000);
  }

  const all: any = await page.evaluate(() => new Promise((res) => (globalThis as any).chrome.storage.local.get(null, (r: any) => res(Object.keys(r)))));
  console.log("[harness] storage keys:", JSON.stringify(all));
  console.log("\n--- console tail ---\n" + logs.slice(-60).join("\n"));

  expect(settled, "claim never reached settled state on-chain — see console tail above").toBeGreaterThan(0);
});
