'use client';

import { useEffect, useRef, useState } from 'react';
import { Send, Sparkles, Loader2, User } from 'lucide-react';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export default function AssistantPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  async function send() {
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    const nextMessages: ChatMessage[] = [...messages, { role: 'user', content: trimmed }];
    setMessages(nextMessages);
    setInput('');
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, history: messages }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Something went wrong.');
      } else {
        setMessages([...nextMessages, { role: 'assistant', content: data.reply }]);
      }
    } catch {
      setError('Could not reach the assistant right now. Try again in a moment.');
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-200px)] max-w-3xl">
      <div>
        <h1 className="font-display text-3xl text-deep font-bold">Assistant</h1>
        <p className="text-ink/50 mt-1">Ask about stock, pricing, your orders, or how to install something.</p>
      </div>

      <div className="flex-1 overflow-y-auto mt-4 space-y-4 pr-1">
        {messages.length === 0 && (
          <div className="rounded-2xl bg-white border border-ink/10 shadow-soft p-6 flex items-start gap-3">
            <div className="rounded-xl bg-wave/10 p-2 flex-shrink-0">
              <Sparkles className="h-4 w-4 text-wave" />
            </div>
            <p className="text-sm text-ink/60">
              Try asking something like &quot;is 1A-AV250LI in stock&quot;, &quot;what&apos;s my price on 50 units
              of 1B-SP3010DI&quot;, or &quot;how do I install the AquaVac 250Li&quot;.
            </p>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`flex gap-3 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {m.role === 'assistant' && (
              <div className="rounded-xl bg-wave/10 p-2 h-fit flex-shrink-0">
                <Sparkles className="h-4 w-4 text-wave" />
              </div>
            )}
            <div
              className={`rounded-2xl px-4 py-3 text-sm max-w-[80%] whitespace-pre-wrap ${
                m.role === 'user' ? 'bg-wave text-white' : 'bg-white border border-ink/10 shadow-soft text-ink'
              }`}
            >
              {m.content}
            </div>
            {m.role === 'user' && (
              <div className="rounded-xl bg-ink/5 p-2 h-fit flex-shrink-0">
                <User className="h-4 w-4 text-ink/40" />
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="flex gap-3 justify-start">
            <div className="rounded-xl bg-wave/10 p-2 h-fit flex-shrink-0">
              <Sparkles className="h-4 w-4 text-wave" />
            </div>
            <div className="rounded-2xl px-4 py-3 bg-white border border-ink/10 shadow-soft flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-ink/40" />
              <span className="text-sm text-ink/40">Thinking...</span>
            </div>
          </div>
        )}

        {error && <p className="text-sm text-coral">{error}</p>}
        <div ref={bottomRef} />
      </div>

      <div className="mt-4 flex gap-2 items-end">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask a question..."
          rows={1}
          className="flex-1 resize-none rounded-2xl border border-ink/10 bg-white px-4 py-3 text-sm shadow-soft focus:border-wave focus:ring-2 focus:ring-wave/20 outline-none"
        />
        <button
          onClick={send}
          disabled={loading || !input.trim()}
          className="rounded-full bg-wave p-3.5 text-white shadow-glow hover:bg-deep transition-colors disabled:opacity-50"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
