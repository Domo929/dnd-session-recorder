'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Clock, Loader2, Search } from 'lucide-react';
import {
  CampaignSearchSourceType,
  formatSearchTimestamp,
  getSafeSearchSnippetHtml,
  getSourceTypeLabel,
} from './campaignSearchHelpers';

interface CampaignSearchResult {
  sessionId: string;
  sessionTitle: string;
  sourceType: CampaignSearchSourceType;
  startTime: number | null;
  speakerLabels: string[];
  snippet: string;
}

interface CampaignSearchResponse {
  results: CampaignSearchResult[];
}

function sourceBadgeClasses(sourceType: CampaignSearchResult['sourceType']) {
  switch (sourceType) {
    case 'transcript':
      return 'bg-blue-100 text-blue-800 border-blue-200';
    case 'summary':
      return 'bg-purple-100 text-purple-800 border-purple-200';
    case 'dm_todo':
      return 'bg-amber-100 text-amber-800 border-amber-200';
  }
}

export default function CampaignSearchCard({ campaignId }: { campaignId: string }) {
  const [term, setTerm] = useState('');
  const [debouncedTerm, setDebouncedTerm] = useState('');

  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedTerm(term), 300);
    return () => clearTimeout(timeout);
  }, [term]);

  const trimmedTerm = debouncedTerm.trim();

  const { data, isFetching, isError } = useQuery<CampaignSearchResponse>({
    queryKey: ['campaign-search', campaignId, debouncedTerm],
    queryFn: async () => {
      const res = await fetch(
        `/api/campaigns/${campaignId}/search?q=${encodeURIComponent(debouncedTerm)}`,
      );
      if (!res.ok) throw new Error('Failed to search campaign');
      return res.json();
    },
    enabled: trimmedTerm.length > 0,
  });

  const results = data?.results ?? [];

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center space-x-2 mb-1">
        <Search className="h-5 w-5 text-gray-700" />
        <h2 className="text-lg font-semibold text-gray-900">Search transcripts</h2>
      </div>
      <p className="text-xs text-gray-500 mb-4">
        Find moments across this campaign&apos;s transcripts, summaries, and DM TODOs.
      </p>

      <div className="relative mb-4">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
        <input
          type="search"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search this campaign..."
          className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
        />
      </div>

      {trimmedTerm.length === 0 ? (
        <p className="text-sm text-gray-500">Enter a search term to find campaign notes.</p>
      ) : isFetching ? (
        <div className="flex items-center space-x-2 py-4">
          <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
          <span className="text-sm text-gray-500">Searching...</span>
        </div>
      ) : isError ? (
        <p className="text-sm text-red-600">Failed to search this campaign.</p>
      ) : results.length === 0 ? (
        <p className="text-sm text-gray-500">No results found.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {results.map((result, index) => (
            <li key={`${result.sessionId}-${result.sourceType}-${result.startTime ?? 'none'}-${index}`} className="py-3">
              <Link href={`/sessions/${result.sessionId}`} className="block group">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <h3 className="text-sm font-semibold text-gray-900 group-hover:text-blue-700">
                    {result.sessionTitle}
                  </h3>
                  <span
                    className={`shrink-0 px-2 py-0.5 rounded-full border text-xs font-medium ${sourceBadgeClasses(result.sourceType)}`}
                  >
                    {getSourceTypeLabel(result.sourceType)}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs text-gray-500 mb-2">
                  {result.startTime != null && (
                    <span className="inline-flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {formatSearchTimestamp(result.startTime)}
                    </span>
                  )}
                  {result.speakerLabels.length > 0 && (
                    <span className="truncate">{result.speakerLabels.join(', ')}</span>
                  )}
                </div>
                <p
                  className="text-sm text-gray-700 leading-relaxed [&_mark]:bg-yellow-200 [&_mark]:rounded-sm [&_mark]:px-0.5"
                  // Preserve server-generated <mark> highlights while escaping snippet text.
                  dangerouslySetInnerHTML={{ __html: getSafeSearchSnippetHtml(result.snippet) }}
                />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
