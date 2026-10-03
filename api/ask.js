// api/ask.js — Richak's Study Buddy (Vercel serverless function)
// Calls Gemini with automatic retry + model fallback to survive "busy" errors.
// Frontend sends: { messages: [{role, content|text}, ...], cls }

const MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
];

const SYSTEM_PROMPT = `You are "Study Buddy", a friendly and expert AI tutor for school students of Class 7 to 10 (West Bengal Board / NCERT level).
You teach ONLY Physics and Chemistry.

Rules:
- Reply in the same language the student uses (English or বাংলা). If they mix, mix naturally.
- Give detailed, well-structured answers: definition, explanation, formula (with units and symbols explained), a simple real-life example, and a solved numerical when relevant.
- Explain deep concepts step by step in simple words, as if teaching in class.
- Use short headings and bullet points where helpful.
- If the question is outside Physics or Chemistry, politely say you can only help with Class 7-10 Physics and Chemistry.
- End with one short tip or a quick practice question when it fits.`;

const MAX_TOTAL_MS = 25000; // vercel.json allows maxDuration 30s
const RETRIES_PER_MODEL = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callGemini(model, body, signal) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify(body),
    signal,
  });
}

async function askWithFallback(body) {
  const start = Date.now();
  let lastStatus = 0;

  for (const model of MODELS) {
    for (let attempt = 0; attempt <= RETRIES_PER_MODEL; attempt++) {
      const remaining = MAX_TOTAL_MS - (Date.now() - start);
      if (remaining < 1500) return { ok: false, status: lastStatus || 503 };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);

      try {
        const r = await callGemini(model, body, controller.signal);
        clearTimeout(timer);

        if (r.ok) {
          const data = await r.json();
          const text =
            data?.candidates?.[0]?.content?.parts
              ?.map((p) => p.text || "")
              .join("") || "";
          if (text.trim()) return { ok: true, text, model };
          lastStatus = 502; // empty/blocked reply -> try next
          break;
        }

        lastStatus = r.status;
        console.error(`[${model}] attempt ${attempt + 1} failed:`, r.status, await r.text());

        // Retry only on busy/rate-limit/server errors; otherwise move to next model
        if (![429, 500, 503, 504].includes(r.status)) break;
        await sleep(600 * 2 ** attempt); // 0.6s, 1.2s
      } catch (err) {
        clearTimeout(timer);
        console.error(`[${model}] network/timeout error:`, err.message);
        lastStatus = 504;
        break;
      }
    }
  }
  return { ok: false, status: lastStatus || 503 };
}

// Pull text out of a chat item in any common shape
function itemText(m) {
  if (!m) return "";
  if (typeof m === "string") return m.trim();
  const t = m.text ?? m.content ?? m.message ?? m.parts?.[0]?.text ?? "";
  return String(t).trim();
}

function isUserItem(m) {
  const r = String((m && (m.role || m.sender || m.from)) || "").toLowerCase();
  return r === "user" || r === "student" || r === "human";
}

// Returns { message, history } from whatever the frontend sent
function parseInput(body) {
  // Main format: { messages: [...] }
  if (Array.isArray(body.messages) && body.messages.length) {
    const items = body.messages
      .map((m) => ({ user: isUserItem(m), text: itemText(m) }))
      .filter((m) => m.text);

    let lastUser = -1;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].user) { lastUser = i; break; }
    }
    if (lastUser !== -1) {
      return {
        message: items[lastUser].text,
        history: items.slice(0, lastUser).map((m) => ({
          role: m.user ? "user" : "model",
          text: m.text,
        })),
      };
    }
  }

  // Fallback: single-field formats
  const keys = ["message", "question", "text", "prompt", "q", "query", "input", "msg", "content", "doubt"];
  let message = "";
  for (const k of keys) {
    if (typeof body[k] === "string" && body[k].trim()) { message = body[k].trim(); break; }
  }
  const history = Array.isArray(body.history)
    ? body.history
        .map((h) => ({ role: isUserItem(h) ? "user" : "model", text: itemText(h) }))
        .filter((h) => h.text)
    : [];
  return { message, history };
}

module.exports = async function handler(req, res) {
  // CORS (harmless if same-origin)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ reply: "Server is not configured (missing API key)." });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const { message, history } = parseInput(body);

    if (!message) {
      return res.status(400).json({ reply: "Please type your doubt first." });
    }
    if (message.length > 2000) {
      return res.status(400).json({ reply: "Your question is too long. Please shorten it." });
    }

    // Keep only the last 6 turns to save tokens
    const contents = history.slice(-6).map((h) => ({
      role: h.role,
      parts: [{ text: h.text.slice(0, 2000) }],
    }));

    // Gemini expects the conversation to start with a user turn
    while (contents.length && contents[0].role !== "user") contents.shift();

    contents.push({ role: "user", parts: [{ text: message }] });

    // Optional class level from the frontend (e.g. "7", "8", "9", "10")
    const cls = body.cls ? String(body.cls).replace(/[^\w\s-]/g, "").slice(0, 20) : "";
    const systemText = cls
      ? `${SYSTEM_PROMPT}\n\nThe student is in Class ${cls}. Match the explanation level to this class.`
      : SYSTEM_PROMPT;

    const payload = {
      systemInstruction: { parts: [{ text: systemText }] },
      contents,
      generationConfig: {
        temperature: 0.6,
        maxOutputTokens: 1500,
      },
    };

    const result = await askWithFallback(payload);

    // reply + answer + text: works with whichever key the frontend reads
    if (result.ok) {
      return res.status(200).json({ reply: result.text, answer: result.text, text: result.text });
    }

    if (result.status === 429 || result.status === 503) {
      return res.status(200).json({
        reply: "The AI is very busy right now. Please try again in a few seconds.",
      });
    }
    return res.status(200).json({
      reply: "Sorry, something went wrong. Please try again.",
    });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(200).json({ reply: "Sorry, something went wrong. Please try again." });
  }
};
