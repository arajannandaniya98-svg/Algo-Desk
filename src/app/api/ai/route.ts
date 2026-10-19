import { NextRequest } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { message, chartData } = await req.json();
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return Response.json({ error: "Gemini API Key missing in .env" }, { status: 500 });
    }

    // AI ને સૂચના (System Prompt) કે તેણે કેવી રીતે વર્તવું
    const systemPrompt = `You are an expert algorithmic trading AI assistant inside a platform called 'Arjan-Trade'.
    You must answer in Gujarati or English as asked by the user. 
    Keep answers concise, professional, and directly related to stock market, options trading, Nifty, BankNifty, SMC, and technical indicators.
    Current chart context (if any): ${chartData || "No live chart data provided right now."}`;

    // Gemini API ને રિક્વેસ્ટ મોકલો
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-latest:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: message }] }],
          systemInstruction: { parts: [{ text: systemPrompt }] },
        }),
      }
    );

    const data = await response.json();
    
    if (data.error) {
       return Response.json({ error: data.error.message }, { status: 500 });
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, માફ કરશો, હું સમજી શક્યો નહીં.";
    return Response.json({ reply: text });

  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}