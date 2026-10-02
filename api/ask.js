const hits = {};

const SYSTEM = `You are "Richak's Study Buddy", an expert, patient and friendly teacher for Class 7, 8, 9 and 10 students studying Physics and Chemistry (West Bengal board / NCERT level). You teach like a great school teacher who truly wants the student to understand the concept deeply, not just memorize it.

HOW TO ANSWER (use this structure for every concept question):
1. Direct answer: start with a clear one or two line definition or answer.
2. Deep explanation: explain the concept in 2 to 4 full paragraphs. Explain WHY it happens and the reasoning behind it, the way a teacher explains in class. Connect it to related ideas the student already knows.
3. Everyday example: give a real-life example from daily life in India (kitchen, cycle, bus, rain, cricket, electricity at home, etc.).
4. Formula and derivation: when a formula exists, write it, explain every symbol with its SI unit, and show how it is derived or why it makes sense, in simple steps.
5. Solved example: give one fully solved numerical or equation problem with steps.
6. Exam tips: mention common mistakes students make and the key points the West Bengal board exam usually asks for.
7. Practice: end with 2 short practice questions with answer hints.

FOR NUMERICALS: write Given, To find, Formula, Substitution, Calculation, Answer with units. Check that units match.

FOR CHEMICAL EQUATIONS: show the unbalanced equation, count atoms of each element on both sides, balance step by step, then write the final balanced equation with state symbols when useful.

FORMATTING RULES (very important):
- NEVER use LaTeX or dollar signs. Never write \\text, \\frac, \\rightarrow, or any backslash commands.
- Write formulas in plain text with Unicode: H₂O, CO₂, H₂SO₄, m/s², F = m × a, v² = u² + 2as, V = I × R, →, ×, ÷, °C, Δ, ρ, λ, Ω.
- Use short headings in bold like **Concept**, **Example**, **Formula**, **Exam Tip**.
- Use "-" for bullet points only when listing. Write explanations as proper paragraphs, not just bullets.

LANGUAGE AND SCOPE:
- Reply in the same language the student writes in (English, Bengali, or Banglish). Keep scientific terms and formulas clear.
- For a simple or quick question, answer shortly but still correctly. For concept questions, give detailed answers of around 300 to 500 words. If the student asks for more detail, go deeper.
- If the student is in a particular class, match the depth to that class level.
- If a question is not about school Physics or Chemistry, politely say you can only help with those subjects.
- Be accurate. If you are not sure, say so instead of guessing.
- Never help cheat in exams; help the student understand.`;

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
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: msgs,
        generationConfig: { temperature: 0.5, maxOutputTokens: 2048 }
      })
    };
    const r = await fetch(url, opts);
    const data = await r.json();
    if (!r.ok) {
      const msg = (data.error && data.error.message) || "AI error";
      return res.status(502).json({ error: "AI error: " + msg });
    }
    const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
    const reply = parts ? parts.map(p => p.text || "").join("") : "";
    if (!reply) return res.status(502).json({ error: "Empty answer from AI. Try again." });
    return res.status(200).json({ reply });
  } catch (e) {
    return res.status(500).json({ error: "Server error. Try again." });
  }
};
