import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 3000;

// Protect the API so only your n8n can call it
const API_KEY = process.env.SCRAPER_API_KEY || "";

app.use((req, res, next) => {
  if (!API_KEY) return next(); // open in dev
  if (req.headers["x-api-key"] === API_KEY) return next();
  res.status(401).json({ error: "Unauthorized" });
});

let browser;
async function getBrowser() {
  if (!browser) browser = await chromium.launch({ headless: true });
  return browser;
}

app.get("/healthz", (req, res) => res.json({ ok: true }));

app.get("/search", async (req, res) => {
  const q = (req.query.query || "").toString().trim();
  const locationText = (req.query.location || "Dubai Marina").toString().trim();
  const max = Math.min(parseInt(req.query.max || "20", 10), 50);
  if (!q) return res.status(400).json({ error: "Missing ?query=" });

  const browser = await getBrowser();
  const context = await browser.newContext({
    locale: "en-US",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36"
  });
  const page = await context.newPage();

  try {
    await page.goto("https://www.talabat.com/uae", { waitUntil: "domcontentloaded", timeout: 60000 });

    // Try common search inputs
    const sels = [
      'input[placeholder*="craving" i]',
      'input[placeholder*="Search" i]',
      "[role=search] input",
      'input[type="search"]'
    ];
    let found = false;
    for (const sel of sels) {
      const el = await page.$(sel);
      if (el) {
        await el.click({ force: true });
        await el.fill(q);
        await page.keyboard.press("Enter");
        found = true;
        break;
      }
    }
    if (!found) {
      await page.goto("https://www.talabat.com/uae/restaurants", { waitUntil: "domcontentloaded" });
    }

    await page.waitForLoadState("networkidle", { timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const items = await page.evaluate((max) => {
      function txt(root, sel) {
        const el = root.querySelector(sel);
        return (el?.textContent || "").trim();
      }
      function num(s) {
        const m = String(s || "").match(/(\d+(\.\d+)?)/);
        return m ? Number(m[1]) : 0;
      }
      const cards = Array.from(document.querySelectorAll(
        'a[href*="/restaurant/"], a[href*="/menu/"], a[href*="/uae/restaurant/"], article a'
      )).slice(0, 120);
      const out = [];
      for (const a of cards) {
        const card = a.closest("article") || a.closest("div") || a;
        const restaurant = txt(card, "h3, [data-test='restaurant-name'], [class*='title']");
        if (!restaurant) continue;
        const priceRaw = txt(card, "[data-test='price'], [class*='price'], .price");
        const discountRaw = txt(card, "[data-test='discount'], [class*='discount']");
        const etaRaw = txt(card, "[data-test='eta'], [class*='delivery-time'], .delivery-time");
        const ratingRaw = txt(card, "[aria-label*='rating'], [data-test*='rating'], [class*='rating']");
        const feeRaw = txt(card, "[data-test='delivery-fee'], [class*='delivery-fee']");
        const o = {
          platform: "talabat",
          restaurant,
          item: "",
          base_price: num(priceRaw),
          discounted_price: num(priceRaw),
          discount_pct: num(discountRaw),
          delivery_fee: num(feeRaw),
          eta_min: num(etaRaw),
          rating: Number((String(ratingRaw).match(/\d+(\.\d+)?/) || [0])[0]) || 0,
          link: a.href,
          last_seen: new Date().toISOString()
        };
        if (o.discount_pct && o.base_price) {
          o.discounted_price = Math.round(o.base_price * (100 - o.discount_pct) / 100 * 100) / 100;
        }
        out.push(o);
        if (out.length >= max) break;
      }
      return out;
    }, max);

    // Simple delivery fee cap from env, default 10 AED
    const MAX_FEE = Number(process.env.MAX_DELIVERY_FEE || 10);
    const filtered = items.filter(o => !o.delivery_fee || o.delivery_fee <= MAX_FEE);

    res.json({ query: q, location: locationText, count: filtered.length, items: filtered });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
});

app.listen(PORT, () => console.log(`Scraper API online on :${PORT}`));
