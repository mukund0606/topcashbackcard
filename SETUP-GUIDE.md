# AI Assistant Modal — Complete Implementation Guide

## Architecture Overview

```
User Browser
    │
    ├── ai-assistant-modal.html (floating widget)
    │       │
    │       ├── Local semantic pre-filter (JS)
    │       └── POST /api/ai-search
    │                   │
    │              Node.js Backend (server.js)
    │                   │
    │         ┌─────────┼──────────────┐
    │         │         │              │
    │     OpenAI     SQLite/Postgres  Redis
    │   Embeddings   (posts + stats)  (cache)
    │         │                              
    │     WordPress REST API (sync every 6h)
    │
    └── POST /api/telegram-notify
                │
           Telegram Bot API
                │
           Admin Chat / Channel
```

---

## 1. Quick Start

### Install Dependencies
```bash
mkdir ai-assistant && cd ai-assistant
npm init -y
npm install express openai node-telegram-bot-api dotenv axios cors ioredis better-sqlite3
```

### .env File
```env
OPENAI_API_KEY=sk-your-key-here
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_ADMIN_CHAT_ID=your-chat-id
TELEGRAM_CHANNEL_ID=@yourchannel          # optional broadcast
WP_REST_BASE=https://yoursite.com/wp-json/wp/v2
SITE_URL=https://yoursite.com
ADMIN_API_KEY=your-secret-admin-key
REDIS_URL=redis://localhost:6379
ALLOWED_ORIGIN=https://yoursite.com
PORT=3001
NODE_ENV=production
```

### Run the Server
```bash
node server.js
```

---

## 2. Telegram Bot Setup (Step by Step)

### Step 1: Create your bot
1. Open Telegram → search for **@BotFather**
2. Send `/newbot`
3. Choose a name: "MySite Assistant"
4. Choose a username: `mysite_assistant_bot`
5. Copy the **bot token** → paste into `.env` as `TELEGRAM_BOT_TOKEN`

### Step 2: Get your Admin Chat ID
1. Message your new bot: `/start`
2. Visit: `https://api.telegram.org/bot<TOKEN>/getUpdates`
3. Copy the `chat.id` value → paste into `.env` as `TELEGRAM_ADMIN_CHAT_ID`

### Step 3: Create a Broadcast Channel (optional)
1. Create a Telegram channel (e.g., @mysite_updates)
2. Add your bot as an admin with "Post Messages" permission
3. Add the channel username to `.env` as `TELEGRAM_CHANNEL_ID`

### Step 4: Register bot commands with BotFather
Send this to @BotFather:
```
/setcommands
```
Then paste:
```
ask - Ask a question and get AI answer + links
trending - See the most popular questions this week
start - Welcome message and available commands
```

### Bot Commands Available
| Command | Action |
|---------|--------|
| `/ask what is SEO` | Returns AI answer + 4 relevant article links |
| `/trending` | Shows top 10 most asked queries |
| `/broadcast <msg>` | (Admin only) Sends to your channel |

---

## 3. WordPress Integration

### Method A: REST API (Recommended, no plugin needed)
The server automatically syncs posts from:
```
https://yoursite.com/wp-json/wp/v2/posts?per_page=100
```
This runs on startup and every 6 hours. No WordPress plugin required.

### Method B: Custom Endpoint (for private posts or custom post types)
Add to your theme's `functions.php`:
```php
add_action('rest_api_init', function() {
    register_rest_route('ai-assistant/v1', '/posts', [
        'methods'  => 'GET',
        'callback' => 'ai_get_all_posts',
        'permission_callback' => function($req) {
            return $req->get_header('x-api-key') === 'your-secret-key';
        }
    ]);
});

function ai_get_all_posts() {
    $posts = get_posts([
        'post_type'      => ['post', 'page', 'faq'], // add your CPTs
        'posts_per_page' => -1,
        'post_status'    => 'publish'
    ]);
    return array_map(function($p) {
        return [
            'id'       => $p->ID,
            'title'    => $p->post_title,
            'slug'     => $p->post_name,
            'excerpt'  => get_the_excerpt($p),
            'content'  => wp_strip_all_tags($p->post_content),
            'category' => implode(',', wp_get_post_categories($p->ID, ['fields'=>'names'])),
            'tags'     => implode(',', wp_get_post_tags($p->ID, ['fields'=>'names'])),
        ];
    }, $posts);
}
```

### Add Modal to WordPress
Option A — `functions.php`:
```php
add_action('wp_footer', function() {
    echo '<script>
    window.AIAssistantConfig = {
        apiEndpoint: "https://yourdomain.com/api/ai-search",
        siteUrl: "https://yoursite.com"
    };
    </script>';
    echo '<script src="https://yourdomain.com/ai-modal.js" defer></script>';
});
```

Option B — Use **WPCode** or **Header Footer Code Manager** plugin to inject the script tag.

---

## 4. Semantic Search — How It Works

```
User Query: "how to make my site faster"
        │
        ▼
OpenAI text-embedding-3-small
        │
        ▼ (1536-dimensional vector)
[0.021, -0.18, 0.44, ...]
        │
        ▼ Cosine Similarity
Compare against all post embeddings in DB
        │
        ▼
Top matches ranked by similarity score
+ Priority boost (admin-configurable)
        │
        ▼
GPT-4o-mini generates 2-3 sentence answer
using top 3 post excerpts as context
        │
        ▼
Response: { answer, posts[{title,slug,score}] }
```

**Why cosine similarity?**
Unlike keyword search, semantic search understands that "make site faster" = "WordPress performance optimization" = "speed up loading time". The vectors capture meaning, not just words.

**Cost estimate:**
- Embedding: ~$0.00002 per query (very cheap)
- GPT-4o-mini answer: ~$0.0002 per query
- 10,000 queries/month ≈ **$2.20 total**

---

## 5. Scalability

### For < 10,000 posts: Current setup works perfectly
- SQLite + in-memory cosine similarity
- Redis caches embeddings and search results
- Cold query: ~800ms | Cached query: ~50ms

### For > 10,000 posts: Switch to Pinecone or pgvector
```javascript
// Replace semanticSearch() with Pinecone query:
const index = pinecone.index('site-posts');
const results = await index.query({
    vector: queryEmbedding,
    topK: 5,
    includeMetadata: true
});
```

### Horizontal scaling
- Deploy server.js on **Railway**, **Render**, or **VPS**
- Use **Upstash Redis** for managed Redis
- Add rate limiting: 20 requests/minute per IP

---

## 6. SEO Benefits

The AI modal is **100% SEO safe** because:
- The modal is loaded with `defer` — does NOT block page render
- All suggested links are real `<a href>` tags that crawlers can follow
- Internal linking from the modal increases crawl depth and pageviews
- No hidden content — the modal is client-side only, invisible to bots
- Increased dwell time and reduced bounce rate → positive ranking signals

**Additional SEO win:** The query analytics tell you exactly what content your audience wants but doesn't exist yet → content gap analysis built-in.

---

## 7. Monetization Ideas

### A. Affiliate Link Injection
Detect commercial intent in queries and append relevant affiliate links:
```javascript
const AFFILIATE_RULES = [
    { keywords: ['hosting', 'wordpress host'], link: 'https://yoursite.com/recommends/hosting', text: '⭐ Recommended Hosting' },
    { keywords: ['seo tool', 'keyword research'], link: 'https://yoursite.com/recommends/semrush', text: '🔍 Try SEMrush Free' },
    { keywords: ['email marketing'], link: 'https://yoursite.com/recommends/convertkit', text: '📧 Start Free with ConvertKit' },
];
// Add these as "Sponsored suggestions" below organic results
```

### B. Lead Capture (Email)
After the 3rd message in a conversation, show:
```
"📩 Want more tips on [detected topic]? Get our free guide:"
[Email input] → [Subscribe]
```
Integrates with Mailchimp/ConvertKit via their API.

### C. Upgrade Prompts
If visitor asks > 5 questions, show:
```
"💡 Get unlimited AI search + personalized recommendations — Join Pro ($9/mo)"
```

### D. Sponsored Answers
For B2B sites: sell "priority placement" in AI responses to partners
(clearly labeled as sponsored).

### E. Data Insights (SaaS)
Package the query analytics dashboard as a paid add-on for agencies
managing multiple WordPress sites.

---

## 8. Monthly Cost Estimate

| Service | Free Tier | Paid |
|---------|-----------|------|
| OpenAI API | — | ~$5-15/month |
| Redis (Upstash) | 10K req/day free | $10/month |
| Server (Railway) | $5 free credits | $10/month |
| Telegram Bot | Always free | Free |
| Domain/SSL | — | Existing |
| **Total** | | **~$25-35/month** |

At just 100 leads captured or 5 affiliate sales, this pays for itself.

---

## 9. File Structure

```
ai-assistant/
├── server.js              ← Backend (Node.js)
├── ai-assistant-modal.html ← Frontend widget
├── admin-dashboard.html   ← Admin panel
├── .env                   ← Config (never commit this)
├── package.json
└── assistant.db           ← Auto-created SQLite database
```

---

## 10. Production Checklist

- [ ] Set `NODE_ENV=production` in `.env`
- [ ] Use webhook mode for Telegram bot (not polling) in production
- [ ] Add rate limiting middleware (express-rate-limit)
- [ ] Set up HTTPS for your API endpoint
- [ ] Configure CORS to only allow your domain
- [ ] Back up SQLite DB daily (or migrate to PostgreSQL)
- [ ] Set up uptime monitoring (Better Uptime / UptimeRobot)
- [ ] Enable Redis persistence (AOF mode)
- [ ] Add Content Security Policy headers to WordPress
