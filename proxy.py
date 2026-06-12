"""
Pixel Neon Entertainment — API Proxy (Python / FastAPI)
=======================================================
API anahtarları sadece bu dosyada / .env'de durur.

Kurulum:
    pip install fastapi uvicorn httpx python-dotenv

Çalıştırma:
    uvicorn proxy:app --host 0.0.0.0 --port 3001

.env dosyası:
    GEMINI_API_KEY=AIzaSy...
    ANTHROPIC_API_KEY=sk-ant-...
    ALLOWED_ORIGIN=https://pixelneon.com.tr
"""

import os, time
from collections import defaultdict
from dotenv import load_dotenv
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import httpx

load_dotenv()

GEMINI_API_KEY   = os.getenv("GEMINI_API_KEY", "")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
ALLOWED_ORIGIN   = os.getenv("ALLOWED_ORIGIN", "https://pixelneon.com.tr")

app = FastAPI(title="Pixel Neon Proxy")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[ALLOWED_ORIGIN],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

# ── Sunucu tarafı rate limiter (IP başına) ────────────────────────────────────
RATE_LIMIT  = 20      # max istek / pencere
RATE_WINDOW = 60      # saniye

ip_counts: dict[str, dict] = defaultdict(lambda: {"count": 0, "start": 0.0})

def check_rate(ip: str):
    now = time.time()
    rec = ip_counts[ip]
    if now - rec["start"] > RATE_WINDOW:
        rec["count"] = 0
        rec["start"] = now
    rec["count"] += 1
    if rec["count"] > RATE_LIMIT:
        raise HTTPException(status_code=429, detail="Çok fazla istek. Lütfen bekleyin.")

def get_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    return forwarded.split(",")[0].strip() if forwarded else request.client.host

# ── Gemini Proxy ──────────────────────────────────────────────────────────────
@app.post("/api/gemini")
async def gemini_proxy(request: Request):
    check_rate(get_ip(request))
    if not GEMINI_API_KEY:
        raise HTTPException(500, "Sunucu yapılandırma hatası: Gemini anahtarı eksik")

    body = await request.json()
    history      = body.get("history", [])
    system_prompt = body.get("systemPrompt", "")
    model        = "gemini-2.5-flash-lite"

    contents = [
        {"role": "model" if m["role"] == "assistant" else "user",
         "parts": [{"text": m["content"]}]}
        for m in history
    ]

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={GEMINI_API_KEY}",
            json={
                "systemInstruction": {"parts": [{"text": system_prompt}]},
                "contents": contents,
                "generationConfig": {"maxOutputTokens": 400},
            },
        )

    if resp.status_code != 200:
        raise HTTPException(502, f"Gemini hatası: {resp.text[:200]}")

    data  = resp.json()
    reply = (data.get("candidates", [{}])[0]
                 .get("content", {})
                 .get("parts", [{}])[0]
                 .get("text"))
    if not reply:
        raise HTTPException(502, "Gemini boş yanıt döndürdü")
    return {"reply": reply.strip()}

# ── Anthropic Proxy ───────────────────────────────────────────────────────────
@app.post("/api/anthropic")
async def anthropic_proxy(request: Request):
    check_rate(get_ip(request))
    if not ANTHROPIC_API_KEY:
        raise HTTPException(500, "Sunucu yapılandırma hatası: Anthropic anahtarı eksik")

    body = await request.json()

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key":         ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "Content-Type":      "application/json",
            },
            json=body,
        )

    if resp.status_code != 200:
        raise HTTPException(502, f"Anthropic hatası: {resp.text[:200]}")

    data  = resp.json()
    reply = (data.get("content", [{}])[0]).get("text")
    if not reply:
        raise HTTPException(502, "Anthropic boş yanıt döndürdü")
    return {"reply": reply.strip()}

# ── Sağlık Kontrolü ───────────────────────────────────────────────────────────
@app.get("/api/health")
async def health():
    return {"status": "ok"}
