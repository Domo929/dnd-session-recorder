'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mic, Square, Trash2, Sparkles, Loader2, AlertCircle } from 'lucide-react';
import Button from '@/components/ui/Button';
import { uploadVoiceSample } from '@/lib/uploadVoiceSample';
import {
  MAX_RECORDING_MS,
  MIN_RECORDING_MS,
  VOICE_RECORDER_MIME_CANDIDATES,
  pickRecorderMimeType,
} from '@/lib/voiceRecording';

interface VoiceSample {
  id: string;
  label: string;
  durationMs: number;
  source: 'enrolled' | 'tagged_from_cluster';
  exemplarCount: number;
  createdAt: string;
}

interface VoiceSamplesResponse {
  voiceSamples: VoiceSample[];
}

function formatDuration(ms: number) {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, '0')}` : `${seconds}s`;
}

export default function VoiceLibraryCard({ campaignId }: { campaignId: string }) {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const releaseStream = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  // Tear down any in-flight capture if the card unmounts mid-recording.
  useEffect(() => {
    return () => {
      stopTimer();
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        recorderRef.current.stop();
      }
      releaseStream();
    };
  }, []);

  const { data, isLoading, isError } = useQuery<VoiceSamplesResponse>({
    queryKey: ['voice-samples', campaignId],
    queryFn: async () => {
      const res = await fetch(`/api/campaigns/${campaignId}/voice-samples`);
      if (!res.ok) throw new Error('Failed to fetch voice samples');
      return res.json();
    },
  });

  const uploadMutation = useMutation({
    mutationFn: async ({ clip, sampleLabel }: { clip: Blob; sampleLabel: string }) =>
      uploadVoiceSample(campaignId, clip, sampleLabel),
    onSuccess: () => {
      setLabel('');
      setElapsedMs(0);
      queryClient.invalidateQueries({ queryKey: ['voice-samples', campaignId] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (sampleId: string) => {
      const res = await fetch(`/api/campaigns/${campaignId}/voice-samples/${sampleId}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to delete voice sample');
      }
    },
    onSuccess: (_data, sampleId) => {
      if (playingId === sampleId) setPlayingId(null);
      queryClient.invalidateQueries({ queryKey: ['voice-samples', campaignId] });
    },
  });

  const finishRecording = () => {
    stopTimer();
    setIsRecording(false);
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }
  };

  const startRecording = async () => {
    setRecordError(null);
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setRecordError('Recording is not supported in this browser.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const mimeType = pickRecorderMimeType(
        VOICE_RECORDER_MIME_CANDIDATES,
        (t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t),
      );
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        releaseStream();
        const recordedMs = Date.now() - startedAtRef.current;
        const clip = new Blob(chunksRef.current, {
          type: mimeType || recorder.mimeType || 'audio/webm',
        });
        chunksRef.current = [];

        if (recordedMs < MIN_RECORDING_MS) {
          setRecordError(
            `Recording too short. Please record at least ${Math.round(MIN_RECORDING_MS / 1000)} seconds.`,
          );
          setElapsedMs(0);
          return;
        }
        if (!label.trim()) {
          setRecordError('Please enter a name for this voice before recording.');
          return;
        }
        uploadMutation.mutate({ clip, sampleLabel: label.trim() });
      };

      startedAtRef.current = Date.now();
      setElapsedMs(0);
      recorder.start();
      setIsRecording(true);

      timerRef.current = setInterval(() => {
        const ms = Date.now() - startedAtRef.current;
        setElapsedMs(ms);
        if (ms >= MAX_RECORDING_MS) finishRecording();
      }, 200);
    } catch {
      releaseStream();
      setRecordError('Microphone access was denied. Please allow it and try again.');
    }
  };

  const handleDelete = (sample: VoiceSample) => {
    if (window.confirm(`Delete the voice sample "${sample.label}"?`)) {
      deleteMutation.mutate(sample.id);
    }
  };

  const canRecord = label.trim().length > 0;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center space-x-2 mb-1">
        <Mic className="h-5 w-5 text-gray-700" />
        <h2 className="text-lg font-semibold text-gray-900">Voice Library</h2>
      </div>
      <p className="text-xs text-gray-500 mb-4">
        Record a short clip of yourself speaking (8–60s) so sessions can label your
        lines automatically.
      </p>

      <div className="mb-4">
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Voice name (e.g. Gandalf, or your name)"
          disabled={isRecording || uploadMutation.isPending}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm disabled:bg-gray-50"
        />
        <div className="flex items-center space-x-3 mt-2">
          {isRecording ? (
            <Button
              variant="danger"
              size="sm"
              onClick={finishRecording}
              className="flex items-center space-x-1"
            >
              <Square className="h-3 w-3" />
              <span>Stop</span>
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={startRecording}
              disabled={!canRecord || uploadMutation.isPending}
              className="flex items-center space-x-1"
            >
              {uploadMutation.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Mic className="h-3 w-3" />
              )}
              <span>{uploadMutation.isPending ? 'Saving...' : 'Record'}</span>
            </Button>
          )}
          {isRecording && (
            <span className="flex items-center space-x-2 text-sm text-gray-600">
              <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
              <span>{formatDuration(elapsedMs)}</span>
              {elapsedMs < MIN_RECORDING_MS && (
                <span className="text-xs text-gray-400">
                  (min {Math.round(MIN_RECORDING_MS / 1000)}s)
                </span>
              )}
            </span>
          )}
        </div>
        {recordError && (
          <p className="flex items-center space-x-1 text-sm text-red-600 mt-2">
            <AlertCircle className="h-4 w-4" />
            <span>{recordError}</span>
          </p>
        )}
        {uploadMutation.isError && (
          <p className="flex items-center space-x-1 text-sm text-red-600 mt-2">
            <AlertCircle className="h-4 w-4" />
            <span>{(uploadMutation.error as Error).message}</span>
          </p>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center space-x-2 py-4">
          <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
          <span className="text-sm text-gray-500">Loading voices...</span>
        </div>
      ) : isError || !data ? (
        <p className="text-sm text-red-600">Failed to load voice samples.</p>
      ) : data.voiceSamples.length === 0 ? (
        <p className="text-sm text-gray-500">No voices recorded yet.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {data.voiceSamples.map((sample) => (
            <li key={sample.id} className="py-3">
              <div className="flex items-start justify-between">
                <div className="min-w-0">
                  <div className="flex items-center space-x-2 flex-wrap">
                    <span className="font-medium text-gray-900">{sample.label}</span>
                    {sample.source === 'tagged_from_cluster' && (
                      <span
                        title="Refined automatically from a tagged session"
                        className="flex items-center space-x-1 px-2 py-0.5 rounded-full border border-purple-200 bg-purple-100 text-purple-800 text-xs font-medium"
                      >
                        <Sparkles className="h-3 w-3" />
                        <span>Auto-promoted</span>
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {formatDuration(sample.durationMs)}
                    {sample.exemplarCount > 1 && ` · ${sample.exemplarCount} samples`}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleDelete(sample)}
                  disabled={deleteMutation.isPending}
                  className="flex items-center space-x-1 text-red-600 hover:text-red-700 hover:bg-red-50 hover:border-red-200"
                >
                  <Trash2 className="h-3 w-3" />
                  <span>Delete</span>
                </Button>
              </div>
              {playingId === sample.id ? (
                <audio
                  className="mt-2 w-full"
                  controls
                  autoPlay
                  src={`/api/campaigns/${campaignId}/voice-samples/${sample.id}/audio`}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setPlayingId(sample.id)}
                  className="mt-1 text-xs text-blue-600 hover:text-blue-700"
                >
                  Play
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
