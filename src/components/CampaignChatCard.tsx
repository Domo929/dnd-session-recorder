'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AlertCircle, Loader2, RefreshCw, Send, Sparkles } from 'lucide-react';
import Button from '@/components/ui/Button';
import { readTextStream, responseErrorMessage } from './campaignChatStream';

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

interface ReindexResponse {
  message: string;
  sessions: number;
  indexed: number;
}

export default function CampaignChatCard({
  campaignId,
  isOwner,
}: {
  campaignId: string;
  isOwner: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reindexNote, setReindexNote] = useState<string | null>(null);
  const noteTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (noteTimeoutRef.current) clearTimeout(noteTimeoutRef.current);
    };
  }, []);

  const reindexMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/campaigns/${campaignId}/reindex`, {
        method: 'POST',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Failed to re-index campaign');
      return body as ReindexResponse;
    },
    onSuccess: (body) => {
      setReindexNote(`Indexed ${body.indexed}/${body.sessions} sessions`);
      if (noteTimeoutRef.current) clearTimeout(noteTimeoutRef.current);
      noteTimeoutRef.current = setTimeout(() => setReindexNote(null), 4000);
    },
  });

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = input.trim();
    if (!content || isStreaming) return;

    const userMessage: ChatMessage = { role: 'user', content };
    const updatedHistory = [...messages, userMessage];
    setMessages([...updatedHistory, { role: 'assistant', content: '' }]);
    setInput('');
    setError(null);
    setIsStreaming(true);

    try {
      const res = await fetch(`/api/campaigns/${campaignId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: updatedHistory }),
      });

      if (!res.ok) {
        throw new Error(await responseErrorMessage(res));
      }
      if (!res.body) {
        throw new Error('No response stream returned');
      }

      await readTextStream(res.body, (chunk) => {
        setMessages((current) => {
          const next = [...current];
          const lastIndex = next.length - 1;
          const lastMessage = next[lastIndex];
          if (lastMessage?.role === 'assistant') {
            next[lastIndex] = {
              ...lastMessage,
              content: lastMessage.content + chunk,
            };
          }
          return next;
        });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to ask the campaign';
      setError(message);
      setMessages((current) => {
        const lastMessage = current[current.length - 1];
        if (lastMessage?.role === 'assistant' && lastMessage.content.length === 0) {
          return current.slice(0, -1);
        }
        return current;
      });
    } finally {
      setIsStreaming(false);
    }
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-start justify-between gap-3 mb-1">
        <div className="flex items-center space-x-2">
          <Sparkles className="h-5 w-5 text-gray-700" />
          <h2 className="text-lg font-semibold text-gray-900">Ask the campaign</h2>
        </div>
        {isOwner && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => reindexMutation.mutate()}
            disabled={reindexMutation.isPending}
            className="flex items-center space-x-1"
          >
            {reindexMutation.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            <span>Re-index</span>
          </Button>
        )}
      </div>
      <p className="text-xs text-gray-500 mb-4">
        Answers are drawn from this campaign&apos;s transcripts and summaries.
      </p>

      <div className="mb-4 h-64 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-3">
        {messages.length === 0 ? (
          <p className="text-sm text-gray-500">
            Ask about NPCs, places, plot threads, or anything that happened in past sessions.
          </p>
        ) : (
          messages.map((message, index) => (
            <div
              key={`${message.role}-${index}`}
              className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
                  message.role === 'user'
                    ? 'bg-blue-600 text-white'
                    : 'bg-white border border-gray-200 text-gray-800'
                }`}
              >
                {message.content || (isStreaming ? 'Thinking...' : '')}
              </div>
            </div>
          ))
        )}
      </div>

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a campaign question..."
          disabled={isStreaming}
          className="min-w-0 flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm disabled:bg-gray-50"
        />
        <Button type="submit" size="sm" disabled={isStreaming || !input.trim()}>
          {isStreaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          <span className="sr-only">Send</span>
        </Button>
      </form>

      {error && (
        <p className="flex items-center space-x-1 text-sm text-red-600 mt-2">
          <AlertCircle className="h-4 w-4" />
          <span>{error}</span>
        </p>
      )}
      {reindexMutation.isError && (
        <p className="flex items-center space-x-1 text-sm text-red-600 mt-2">
          <AlertCircle className="h-4 w-4" />
          <span>{(reindexMutation.error as Error).message}</span>
        </p>
      )}
      {reindexNote && <p className="text-sm text-green-700 mt-2">{reindexNote}</p>}
    </div>
  );
}
