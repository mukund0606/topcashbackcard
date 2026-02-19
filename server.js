/**
 * AI Assistant Backend — Node.js (Express)
 * Features: Semantic Search, OpenAI embeddings, Telegram Bot, Analytics, WP REST API sync
 *
 * Install: npm install express openai node-telegram-bot-api
 *          dotenv axios cors ioredis pg better-sqlite3
 */

require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const TelegramBot = require('node-telegram-bot-api');
const Database  = require('better-sqlite3');
const axios     = require('axios');
const Redis     = require('ioredis');

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN }));
app.use(express.json());

// ─────────────────────────────────────────────
// INITIALIZATION
// ─────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
const redis  = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const db     = new Database('./assistant.db');

// Telegram Bot (polling for dev, webhook for prod)
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  polling: process.env.NODE_ENV !== 'production'
});
const ADMIN_CHAT_ID  = process.env.TELEGRAM_ADMIN_CHAT_ID;
const CHANNEL_ID     = process.env.TELEGRAM_CHANNEL_ID; // optional broadcast channel

// ─────────────────────────────────────────────
// DATABASE SETUP (SQLite — swap to PostgreSQL for prod)
// ─────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id         INTEGER PRIMARY KEY,
    title      TEXT NOT NULL,
    slug       TEXT NOT NULL,
    excerpt    TEXT,
    content    TEXT,
    category   TEXT,
    tags       TEXT,
    priority   INTEGER DEFAULT 0,
    embedding  BLOB,           -- stored as JSON string
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS queries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    query      TEXT NOT NULL,
    ip         TEXT,
    page       TEXT,
    results    INTEGER DEFAULT 0,
    ts         INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS query_stats (
    query_hash TEXT PRIMARY KEY,
    query_text TEXT NOT NULL,
    count      INTEGER DEFAULT 1,
    last_seen  INTEGER NOT NULL
  );
`);

// ─────────────────────────────────────────────
// WORDPRESS SYNC  — pulls posts via WP REST API
// ─────────────────────────────────────────────
async function syncWordPressPosts() {
  const wpBase = process.env.WP_REST_BASE; // e.g. https://yoursite.com/wp-json/wp/v2
  if (!wpBase) return console.log('[WP Sync] No WP_REST_BASE set, skipping sync');

  try {
    console.log('[WP Sync] Starting WordPress post sync...');
    let page = 1, imported = 0;

    while (true) {
      const { data: posts } = await axios.get(`${wpBase}/posts`, {
        params: { per_page: 100, page, _embed: 1 }
      });
      if (!posts.length) break;

      for (const p of posts) {
        const tags     = p._embedded?.['wp:term']?.[1]?.map(t => t.name).join(',') || '';
        const category = p._embedded?.['wp:term']?.[0]?.[0]?.name || '';
        const excerpt  = p.excerpt?.rendered?.replace(/<[^>]+>/g, '').trim().slice(0, 400) || '';
        const slug     = p.slug;

        // Generate embedding for semantic search

       db.prepare(`
  INSERT OR REPLACE INTO posts (id, title, slug, excerpt, content, category, tags, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
`).run(p.id, p.title.rendered, slug, excerpt, '', category, tags);


        imported++;
      }
      page++;
    }
    console.log(`[WP Sync] Synced ${imported} posts`);
  } catch (err) {
    console.error('[WP Sync] Error:', err.message);
  }
}

// ─────────────────────────────────────────────
// EMBEDDING GENERATION (Gemini text-embedding-3-small)
// ─────────────────────────────────────────────
async function semanticSearch(query, limit = 5) {
  const cacheKey = `search:${query.toLowerCase().replace(/\s+/g, '_').slice(0, 80)}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const posts = db.prepare('SELECT * FROM posts').all();

  const scored = posts
    .map(post => {
      const text = (post.title + " " + post.excerpt).toLowerCase();
      const score = text.includes(query.toLowerCase()) ? 0.9 : 0.3;
      return { ...post, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  await redis.setex(cacheKey, 3600, JSON.stringify(scored));
  return scored;
}

// ─────────────────────────────────────────────
// COSINE SIMILARITY
// ─────────────────────────────────────────────
function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ─────────────────────────────────────────────
// SEMANTIC SEARCH
// ─────────────────────────────────────────────
async function semanticSearch(query, limit = 5) {
  const cacheKey = `search:${query.toLowerCase().replace(/\s+/g, '_').slice(0, 80)}`;
  const cached   = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const queryEmbedding = await generateEmbedding(query);
  const posts = db.prepare('SELECT * FROM posts').all();

  const scored = posts
    .map(post => {
      if (!post.embedding) return null;
      const postEmbedding = JSON.parse(post.embedding);
      const similarity    = cosineSimilarity(queryEmbedding, postEmbedding);
      const priorityBoost = (post.priority || 0) * 0.05;
      return { ...post, score: Math.min(1, similarity + priorityBoost), tags: post.tags?.split(',') || [] };
    })
    .filter(p => p && p.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  await redis.setex(cacheKey, 3600, JSON.stringify(scored)); // cache 1h
  return scored;
}

// ─────────────────────────────────────────────
// AI ANSWER GENERATION (GPT-4o-mini for cost efficiency)
// ─────────────────────────────────────────────
async function generateAnswer(query, matchedPosts) {
  const context = matchedPosts.slice(0, 3).map(p =>
    `Article: "${p.title}"\nExcerpt: ${p.excerpt}`
  ).join('\n\n');

  const prompt = `
User question: ${query}

Relevant content:
${context || "No exact match"}

Give short helpful answer and encourage reading articles.
`;

  const result = await geminiModel.generateContent(prompt);
  return result.response.text();
}
// ─────────────────────────────────────────────
// API ROUTES
// ─────────────────────────────────────────────

// Main AI search endpoint
app.post('/api/ai-search', async (req, res) => {
  const { query } = req.body;
  if (!query || query.length > 500) return res.status(400).json({ error: 'Invalid query' });

  try {
    const [matchedPosts, answer] = await Promise.all([
      semanticSearch(query),
      semanticSearch(query).then(posts => generateAnswer(query, posts))
    ]);

    // Log query
    db.prepare('INSERT INTO queries (query, ip, page, results, ts) VALUES (?,?,?,?,?)')
      .run(query, req.ip, req.body.page || '', matchedPosts.length, Date.now());

    // Update query stats
    const hash = Buffer.from(query.toLowerCase().trim()).toString('base64').slice(0, 32);
    db.prepare(`
      INSERT INTO query_stats (query_hash, query_text, count, last_seen)
      VALUES (?,?,1,?)
      ON CONFLICT(query_hash) DO UPDATE SET count = count + 1, last_seen = excluded.last_seen
    `).run(hash, query.toLowerCase().trim(), Date.now());

    res.json({
      answer,
      posts: matchedPosts.map(p => ({
        id:       p.id,
        title:    p.title,
        slug:     p.slug,
        category: p.category,
        score:    Math.round(p.score * 100)
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Search failed', answer: 'I encountered an issue. Please try again or browse our articles directly.' });
  }
});

// Telegram notification endpoint
app.post('/api/telegram-notify', async (req, res) => {
  const { query, posts } = req.body;
  if (!ADMIN_CHAT_ID) return res.json({ ok: false });

  try {
    const links = posts.slice(0, 4).map((p, i) =>
      `${i + 1}. [${p.title}](${p.url})`
    ).join('\n');

    await bot.sendMessage(ADMIN_CHAT_ID,
      `🔍 *New Query*\n\n"${query}"\n\n📎 *Matched Articles:*\n${links || '_No matches_'}`,
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false });
  }
});

// Analytics — track clicks/events
app.post('/api/track-query', async (req, res) => {
  // Store to DB or forward to GA4 Measurement Protocol
  res.json({ ok: true });
});

// Admin: top queries
app.get('/api/admin/top-queries', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: 'Unauthorized' });

  const rows = db.prepare(
    'SELECT query_text, count, last_seen FROM query_stats ORDER BY count DESC LIMIT 50'
  ).all();
  res.json({ queries: rows });
});

// Admin: sync WordPress posts
app.post('/api/admin/sync-posts', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  syncWordPressPosts().catch(console.error);
  res.json({ message: 'Sync started' });
});

// Admin: update post priority
app.patch('/api/admin/posts/:id/priority', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: 'Unauthorized' });

  const { priority } = req.body;
  db.prepare('UPDATE posts SET priority = ? WHERE id = ?').run(priority, req.params.id);
  redis.flushdb(); // clear cache so new priorities take effect
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// TELEGRAM BOT HANDLERS
// ─────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `👋 Welcome to the *Site Assistant Bot*!\n\nCommands:\n/ask <question> — AI search\n/trending — Popular articles\n/broadcast — (Admin) Send update`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/ask (.+)/, async (msg, match) => {
  const query   = match[1];
  const chatId  = msg.chat.id;
  bot.sendMessage(chatId, '🔍 Searching...');

  const posts  = await semanticSearch(query, 4);
  const answer = await generateAnswer(query, posts);

  const links = posts.map((p, i) =>
    `${i + 1}. [${p.title}](${process.env.SITE_URL}/${p.slug})`
  ).join('\n');

  bot.sendMessage(chatId,
    `*Answer:*\n${answer}\n\n${links ? `📎 *Relevant Articles:*\n${links}` : '_No exact match found. Browse all articles on the site._'}`,
    { parse_mode: 'Markdown', disable_web_page_preview: false }
  );
});

bot.onText(/\/trending/, async (msg) => {
  const top = db.prepare(
    'SELECT query_text, count FROM query_stats ORDER BY count DESC LIMIT 10'
  ).all();
  const text = top.map((q, i) => `${i+1}. "${q.query_text}" (${q.count}×)`).join('\n');
  bot.sendMessage(msg.chat.id, `📊 *Top Queries This Week:*\n\n${text || 'No data yet'}`, { parse_mode: 'Markdown' });
});

// Admin broadcast (from Telegram itself)
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  if (String(msg.chat.id) !== String(ADMIN_CHAT_ID)) return;
  const message = match[1];
  if (CHANNEL_ID) {
    bot.sendMessage(CHANNEL_ID, `📢 ${message}`);
    bot.sendMessage(msg.chat.id, '✅ Broadcast sent');
  } else {
    bot.sendMessage(msg.chat.id, '⚠️ No TELEGRAM_CHANNEL_ID configured');
  }
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ AI Assistant backend running on port ${PORT}`);
  // Run WP sync on startup, then every 6 hours
  syncWordPressPosts();
  setInterval(syncWordPressPosts, 6 * 60 * 60 * 1000);
});

module.exports = app;
[root@ip-172-31-9-156 topcashbackcard]#
