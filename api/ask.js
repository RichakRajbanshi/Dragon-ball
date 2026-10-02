const hits = {};
const SYSTEM = `You are "Richak's Study Buddy", a friendly tutor for school students of Class 7, 8, 9 and 10 studying Physics and Chemistry (West Bengal board / NCERT level).
- Explain step by step in simple words, with a small everyday example.
- Show formulas and calculations clearly, with units.
- Reply in the same language the student writes in (English, Bengali, or Banglish).
- Keep answers short (under 200 words) unless asked for more.
- If a question is not about school Physics or Chemistry, politely say you can only help with those subjects.
- End with one short check-question or tip when useful. Never help cheat in exams; help them understand.`;

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const ip = (req.headers["x-forwarded-for"] || "x").split(",")[0];
  const now = Date.now();
  hits[ip] = (hits[ip] || []).filter(t => now - t < 60000);
  if (hits[ip].length >= 6) return res.status(429).json({ error: "Too many questions. Wait a minute." });
  hits[ip].push(now);

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "API key not set on server." });

  let msgs = (req.body && req.body.messages) || [];
  msgs = msgs.slice(-10).map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: String(m.content || "").slice(0, 2000) }]
  }));
  if (!msgs.length || msgs[0].role !== "user") return res.status(400).json({ error: "Bad request" });
  const cls = parseInt(req.body.cls, 10);
  const system = SYSTEM + (cls >= 7 && cls <= 10 ? `\nThe student is in Class ${cls}.` : "");
  const model = process.env.MODEL || "gemini-3.8-flash";

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const opts = {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: msgs,
        generationConfig: { maxOutputTokens: 700 }
      })
    };
    let r, d;
    for (let i = 0; i < 3; i++) {
      r = await fetch(url, opts);
      d = await r.json();
      if (r.ok || (r.status !== 503 && r.status !== 429)) break;
      await new Promise(s => setTimeout(s, 1500));
    }
    if (!r.ok) return res.status(502).json({ error: "AI is busy, please try again in a minute." });
    const reply = ((d.candidates || [])[0]?.content?.parts || []).map(p => p.text || "").join("");
    if (!reply) return res.status(502).json({ error: "No answer, try rephrasing." });
    return res.status(200).json({ reply });
  } catch (e) {
    return res.status(500).json({ error: "Something went wrong." });
  }
};
