"use client";
import { useState } from "react";

export function AIChat() {
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<{ role: "user" | "ai"; text: string }[]>([
    { role: "ai", text: "નમસ્તે! હું તમારો AI ટ્રેડિંગ આસિસ્ટન્ટ છું. આજે માર્કેટમાં શું મદદ કરું?" }
  ]);

  const sendMessage = async () => {
    if (!input.trim()) return;
    const userMsg = input.trim();
    setMessages((prev) => [...prev, { role: "user", text: userMsg }]);
    setInput("");
    setLoading(true);

    try {
      // અહીં તમે ભવિષ્યમાં ચાર્ટનું સિગ્નલ પણ મોકલી શકો છો (chartData)
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMsg, chartData: "User is asking a general trading question." }),
      });
      
      const data = await res.json();
      if (data.reply) {
        setMessages((prev) => [...prev, { role: "ai", text: data.reply }]);
      } else {
        setMessages((prev) => [...prev, { role: "ai", text: "Error: " + (data.error || "Unknown error") }]);
      }
    } catch (err) {
      setMessages((prev) => [...prev, { role: "ai", text: "ઇન્ટરનેટ કનેક્શન અથવા API માં એરર છે." }]);
    }
    setLoading(false);
  };

  return (
    <div className="fixed bottom-4 right-4 z-50">
      {isOpen ? (
        <div className="w-80 h-96 bg-[#0d1320] border border-sky-500/40 rounded-xl shadow-2xl flex flex-col overflow-hidden">
          {/* Header */}
          <div className="bg-[#172338] px-4 py-3 flex items-center justify-between border-b border-sky-500/30">
            <span className="font-bold text-sky-400 flex items-center gap-2">🤖 AI Assistant</span>
            <button onClick={() => setIsOpen(false)} className="text-slate-400 hover:text-white font-bold text-lg">✕</button>
          </div>
          
          {/* Messages Area */}
          <div className="flex-1 p-3 overflow-y-auto space-y-3 flex flex-col bg-[#0b0f17]">
            {messages.map((m, i) => (
              <div key={i} className={`text-xs p-2.5 rounded-lg max-w-[85%] leading-relaxed ${
                m.role === "user" 
                  ? "bg-sky-500/20 text-sky-100 self-end rounded-br-none border border-sky-500/30" 
                  : "bg-[#1f2937] text-slate-200 self-start rounded-bl-none border border-slate-600"
              }`}>
                {m.text}
              </div>
            ))}
            {loading && <div className="text-xs text-sky-400 self-start animate-pulse">વિચારી રહ્યું છે...</div>}
          </div>
          
          {/* Input Area */}
          <div className="p-3 bg-[#172338] border-t border-sky-500/30 flex gap-2">
            <input
              type="text"
              className="input flex-1 text-xs py-1.5 px-2 bg-[#0b0f17]"
              placeholder="માર્કેટ વિશે કંઈપણ પૂછો..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendMessage()}
            />
            <button 
              className="btn btn-primary btn-xs font-bold px-3 bg-sky-500 hover:bg-sky-400 text-white" 
              onClick={sendMessage} 
              disabled={loading}
            >
              Send
            </button>
          </div>
        </div>
      ) : (
        // Floating Button
        <button
          onClick={() => setIsOpen(true)}
          className="w-14 h-14 bg-sky-500 hover:bg-sky-400 text-white rounded-full shadow-lg shadow-sky-500/30 flex items-center justify-center text-2xl border border-sky-300 transition-transform hover:scale-110 animate-bounce-slow"
          title="Open AI Assistant"
        >
          🤖
        </button>
      )}
    </div>
  );
}