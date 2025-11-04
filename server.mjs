import express from 'express';
import { chromium } from 'playwright';

const app = express();
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY || 'sk_live_1234567890';
const MAX_DELIVERY_FEE = parseFloat(process.env.MAX_DELIVERY_FEE || '10');
const RATE_LIMIT_WINDOW = 15000; // 15 seconds

// Simple in-memory rate limiter
const rateLimiter = new Map();

// Middleware: API Key check
function requireAuth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Middleware: Rate limiting (1 req per 15s per IP)
function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const lastRequest = rateLimiter.get(ip);
  
  if (lastRequest && now - lastRequest < RATE_LIMIT_WINDOW) {
    return res.status(429).json({ 
      error: 'Rate limit exceeded', 
      retry_after: Math.ceil((RATE_LIMIT_WINDOW - (now - lastRequest)) / 1000) 
    });
  }
  
  rateLimiter.set(ip, now);
  next();
}

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  
  if (req.method === 'OPTIONS') {
    return res.status(204).send();
  }
  next();
});

// Health check
app.get('/healthz', requireAuth, (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// Search endpoint
app.get('/search', requireAuth, rateLimit, async (req, res) => {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const startTime = Date.now();
  
  console.log(`[${requestId}] Search request started`);
  
  const { query, location, max = 5 } = req.query;
  
  if (!query || !location) {
    return res.status(400).json({ 
      error: 'Missing required parameters: query and location' 
    });
  }

  let browser;
  const timeout = 28000; // 28 seconds (leave 2s buffer for response)
  
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Request timeout')), timeout);
  });

  try {
    const scrapePromise = (async () => {
      console.log(`[${requestId}] Launching browser (${Date.now() - startTime}ms)`);
      
      browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-zygote',
          '--single-process',
          '--disable-extensions'
        ]
      });

      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      });
      
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.setDefaultNavigationTimeout(15000);

      // Navigate to Talabat
      const searchUrl = `https://www.talabat.com/uae/restaurants?search=${encodeURIComponent(query)}`;
      console.log(`[${requestId}] Navigating to Talabat (${Date.now() - startTime}ms)`);
      
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
      
      // Wait a moment for dynamic content
      await page.waitForTimeout(2000);
      
      console.log(`[${requestId}] Scraping results (${Date.now() - startTime}ms)`);

      // Scrape restaurant cards
      const items = await page.evaluate((maxItems, maxFee) => {
        const results = [];
        const cards = document.querySelectorAll('[data-testid="RESTAURANT_CARD"], .restaurant-card, [class*="restaurant"]');
        
        for (let i = 0; i < Math.min(cards.length, maxItems * 2); i++) {
          try {
            const card = cards[i];
            
            // Extract restaurant name
            const nameEl = card.querySelector('[data-testid="RESTAURANT_NAME"], h3, h4, [class*="name"]');
            const restaurant = nameEl?.textContent?.trim();
            
            if (!restaurant) continue;

            // Extract link
            const linkEl = card.querySelector('a[href]');
            const link = linkEl ? 'https://www.talabat.com' + linkEl.getAttribute('href') : null;
            
            // Extract price/discount info
            const priceText = card.textContent;
            let discountPct = null;
            const discountMatch = priceText.match(/(\d+)%\s*off/i);
            if (discountMatch) {
              discountPct = parseInt(discountMatch[1]);
            }

            // Extract delivery fee
            let deliveryFee = null;
            const feeMatch = priceText.match(/AED\s*([\d.]+)\s*delivery/i) || 
                            priceText.match(/delivery\s*[:-]?\s*AED\s*([\d.]+)/i);
            if (feeMatch) {
              deliveryFee = parseFloat(feeMatch[1]);
            } else if (/free\s*delivery/i.test(priceText)) {
              deliveryFee = 0;
            }

            // Skip if delivery fee exceeds max
            if (deliveryFee !== null && deliveryFee > maxFee) {
              continue;
            }

            // Extract ETA
            let etaMin = null;
            const etaMatch = priceText.match(/(\d+)[-–]\s*(\d+)\s*min/i) || 
                           priceText.match(/(\d+)\s*min/i);
            if (etaMatch) {
              etaMin = parseInt(etaMatch[2] || etaMatch[1]);
            }

            // Extract rating
            let rating = null;
            const ratingMatch = priceText.match(/([\d.]+)\s*[★⭐]/);
            if (ratingMatch) {
              rating = parseFloat(ratingMatch[1]);
            }

            results.push({
              platform: 'talabat',
              restaurant,
              base_price: null, // Talabat doesn't show base prices easily
              discounted_price: null,
              discount_pct: discountPct,
              delivery_fee: deliveryFee,
              eta_min: etaMin,
              rating: rating,
              link: link
            });

            if (results.length >= maxItems) break;
          } catch (err) {
            console.error('Error parsing card:', err);
          }
        }
        
        return results;
      }, parseInt(max), MAX_DELIVERY_FEE);

      await browser.close();
      browser = null;

      console.log(`[${requestId}] Scrape complete: ${items.length} items (${Date.now() - startTime}ms)`);

      if (items.length === 0) {
        return {
          message: 'No restaurants found. Try a different query or location.',
          items: [],
          meta: { query, location, duration_ms: Date.now() - startTime }
        };
      }

      return {
        items,
        meta: {
          query,
          location,
          count: items.length,
          duration_ms: Date.now() - startTime,
          request_id: requestId
        }
      };
    })();

    const result = await Promise.race([scrapePromise, timeoutPromise]);
    res.json(result);

  } catch (error) {
    console.error(`[${requestId}] Error:`, error.message);
    
    if (browser) {
      try {
        await browser.close();
      } catch (closeErr) {
        console.error('Error closing browser:', closeErr);
      }
    }

    res.status(500).json({ 
      error: 'Scraping failed', 
      message: error.message,
      request_id: requestId
    });
  }
});

// Cleanup rate limiter every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamp] of rateLimiter.entries()) {
    if (now - timestamp > RATE_LIMIT_WINDOW * 2) {
      rateLimiter.delete(ip);
    }
  }
}, 300000);

app.listen(PORT, () => {
  console.log(`✅ Talabat scraper online on :${PORT}`);
});
