'use client';

import { useEffect, useRef, useState } from 'react';
import { Send, Sparkles, Loader2, User, AlertCircle } from 'lucide-react';
import { ProductDetailModal, StockEntry } from '@/components/ProductDetailModal';
import { useSelectedCustomer } from '@/components/SelectedCustomerContext';

interface ChatProduct {
  sku: string;
  name?: string | null;
  totalOnHand: number;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  products?: ChatProduct[];
}

const SUGGESTIONS = [
  'What sand filters do you have?',
  'Is 1A-AV250LI in stock?',
  "What's my price on 50 units of 1B-SP3010DI?",
];

export default function AssistantPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const { selectedCustomer } = useSelectedCustomer();
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<StockEntry | null>(null);
  const [selectedLoading, setSelectedLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  async function sendMessage(text: string) {
    const trimmed = text.trim();
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
        body: JSON.stringify({
          message: trimmed,
          history: messages.map((m) => ({ role: m.role, content: m.content })),
          customerCode: selectedCustomer?.code,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Something went wrong.');
      } else {
        setMessages([...nextMessages, { role: 'assistant', content: data.reply, products: data.products ?? [] }]);
      }
    } catch {
      setError('Could not reach the assistant right now. Try again in a moment.');
    } finally {
      setLoading(false);
    }
  }

  async function openProduct(sku: string) {
    setSelectedLoading(true);
    try {
      const res = await fetch(`/api/stock?sku=${encodeURIComponent(sku)}`);
      const data = await res.json();
      if (res.ok) setSelected(data);
    } finally {
      setSelectedLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
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
          <div className="rounded-2xl bg-white border border-ink/10 shadow-soft p-6 space-y-4">
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-wave/10 p-2 flex-shrink-0">
                <Sparkles className="h-4 w-4 text-wave" />
              </div>
              <p className="text-sm text-ink/60">
                Describe what you're after, ask about a price or order, or just give me a partial code -
                I'll search either way. Try one of these:
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => sendMessage(s)}
                  className="rounded-full border border-wave/20 bg-wave/5 px-3.5 py-2 text-sm text-deep hover:bg-wave/10 transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`flex gap-3 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {m.role === 'assistant' && (
              <div className="rounded-xl bg-wave/10 p-2 h-fit flex-shrink-0">
                <Sparkles className="h-4 w-4 text-wave" />
              </div>
            )}
            <div className={`max-w-[85%] ${m.role === 'user' ? '' : 'space-y-2'}`}>
              <div
                className={`rounded-2xl px-4 py-3 text-sm whitespace-pre-wrap ${
                  m.role === 'user' ? 'bg-wave text-white' : 'bg-white border border-ink/10 shadow-soft text-ink'
                }`}
              >
                {m.content}
              </div>

              {m.products && m.products.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {m.products.map((p) => (
                    <button
                      key={p.sku}
                      onClick={() => openProduct(p.sku)}
                      className="text-left rounded-xl bg-white border border-ink/10 shadow-soft px-3.5 py-2.5 hover:border-wave/30 hover:shadow-glow transition-all"
                    >
                      <p className="text-sm font-medium text-ink leading-snug line-clamp-1">{p.name || p.sku}</p>
                      <div className="flex items-center justify-between mt-1">
                        <p className="text-[11px] text-ink/40 font-mono">{p.sku}</p>
                        {p.totalOnHand > 0 ? (
                          <span className="text-[11px] font-semibold text-splash">{p.totalOnHand} in stock</span>
                        ) : (
                          <span className="text-[11px] font-semibold text-amber">Out of stock</span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
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

        {error && (
          <div className="flex items-start gap-2 rounded-xl bg-coral/10 px-3.5 py-2.5 text-sm text-coral">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
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
          onClick={() => sendMessage(input)}
          disabled={loading || !input.trim()}
          className="rounded-full bg-wave p-3.5 text-white shadow-glow hover:bg-deep transition-colors disabled:opacity-50"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>

      {selectedLoading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20">
          <div className="rounded-2xl bg-white shadow-soft px-6 py-4 flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-wave" />
            <span className="text-sm text-ink/60">Loading product...</span>
          </div>
        </div>
      )}

      {selected && <ProductDetailModal item={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
