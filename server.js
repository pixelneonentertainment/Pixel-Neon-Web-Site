/**
 * Pixel Neon Entertainment — API Proxy (Node.js / Express)
 * =========================================================
 * API anahtarları sadece bu dosyada durur — asla frontend'e gönderilmez.
 *
 * Kurulum:
 *   npm install express node-fetch dotenv cors
 *   node server.js
 *
 * .env dosyası (server.js yanına koy):
 *   GEMINI_API_KEY=AIzaSy...
 *   ANTHROPIC_API_KEY=sk-ant-...
 *   PORT=3001
 *   ALLOWED_ORIGIN=https://pixelneon.com.tr
 */

require('dotenv').config();
const express = require('express');
const cors    = require('cors');

// node-fetch v3 ESM-only olduğu için v2 kullan: npm install node-fetch@2
const fetch   = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── CORS ──────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://pixelneon.com.tr';
app.use(cors({
    origin: function(origin, cb) {
        // origin === undefined → aynı sunucudan (curl, Postman) gelen istekler
        if (!origin || origin === ALLOWED_ORIGIN) return cb(null, true);
        cb(new Error('CORS: izin verilmeyen kaynak: ' + origin));
    }
}));
app.use(express.json({ limit: '16kb' }));

// ── RATE LIMITER (sunucu tarafı, IP başına) ───────────────────────────────────
const RATE_LIMIT  = 20;      // max istek / pencere
const RATE_WINDOW = 60_000;  // 60 saniye

const ipMap = new Map(); // ip → { count, windowStart }

function serverRateLimit(req, res, next) {
    const ip  = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    const now = Date.now();
    let   rec = ipMap.get(ip);

    if (!rec || now - rec.windowStart > RATE_WINDOW) {
        rec = { count: 1, windowStart: now };
    } else {
        rec.count++;
    }
    ipMap.set(ip, rec);

    if (rec.count > RATE_LIMIT) {
        return res.status(429).json({ error: 'Çok fazla istek. Lütfen bekleyin.' });
    }
    next();
}

// ── GEMINI PROXY ──────────────────────────────────────────────────────────────
app.post('/api/gemini', serverRateLimit, async (req, res) => {
    try {
        const { history = [], systemPrompt = '' } = req.body;
        const model    = 'gemini-2.5-flash-lite';
        const apiKey   = process.env.GEMINI_API_KEY;
        if (!apiKey) return res.status(500).json({ error: 'Sunucu yapılandırma hatası' });

        const contents = history.map(m => ({
            role:  m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
        }));

        const upstream = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
            {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    systemInstruction: { parts: [{ text: systemPrompt }] },
                    contents,
                    generationConfig: { maxOutputTokens: 400 }
                })
            }
        );

        if (!upstream.ok) {
            const err = await upstream.text();
            return res.status(502).json({ error: 'Gemini hatası: ' + err.slice(0, 200) });
        }

        const data  = await upstream.json();
        const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!reply) return res.status(502).json({ error: 'Gemini boş yanıt döndürdü' });

        res.json({ reply });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── ANTHROPIC PROXY ───────────────────────────────────────────────────────────
app.post('/api/anthropic', serverRateLimit, async (req, res) => {
    try {
        const { model, max_tokens, system, messages } = req.body;
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) return res.status(500).json({ error: 'Sunucu yapılandırma hatası' });

        const upstream = await fetch('https://api.anthropic.com/v1/messages', {
            method:  'POST',
            headers: {
                'Content-Type':      'application/json',
                'x-api-key':         apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({ model, max_tokens, system, messages })
        });

        if (!upstream.ok) {
            const err = await upstream.text();
            return res.status(502).json({ error: 'Anthropic hatası: ' + err.slice(0, 200) });
        }

        const data  = await upstream.json();
        const reply = data?.content?.[0]?.text;
        if (!reply) return res.status(502).json({ error: 'Anthropic boş yanıt döndürdü' });

        res.json({ reply });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── SAĞLIK KONTROLÜ ───────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () =>
    console.log(`[Pixel Neon Proxy] Dinleniyor: http://localhost:${PORT}`)
);
