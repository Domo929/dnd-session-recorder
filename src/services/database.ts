import { randomBytes } from 'crypto';
import { prisma } from '../lib/prisma';
import { Prisma, Campaign, GamingSession, Transcription, Summary, Upload, UploadStorage, VoiceSample, VoiceSampleSource, TranscriptionMode, DiarizationJob, DiarizationStatus, VoiceExemplarSource, SessionSpeakerCluster, SessionNpcSuggestion } from '@prisma/client';
import { cosineSimilarity, deserializeEmbedding, getFingerprintConfig, selectExemplarsToEvict, type VoiceFingerprint } from '@/lib/voiceFingerprint';
import { getRetentionConfig } from '@/lib/retention';

export interface CreateCampaignData {
  name: string;
  description?: string;
  systemPrompt?: string;
  userId: string;
}

export interface CreateSessionData {
  userId: string;
  campaignId: string;
  title: string;
  sessionDate: Date;
  uploadId?: string;
  duration?: number;
  status?: string;
  transcriptionMode?: TranscriptionMode;
}

export interface CreateUploadData {
  userId: string;
  filename: string;
  originalName: string;
  path: string;
  size: number;
  mimetype: string;
  duration?: number;
  storage?: UploadStorage;
  audioExpiresAt?: Date | null;
}

export interface SessionWithIncludes extends GamingSession {
  campaign: { id: string; name: string };
  transcriptions: Transcription[];
  summary: Summary | null;
  upload: Upload | null;
}

export interface SessionListItem extends GamingSession {
  campaign: { id: string; name: string };
  _count: {
    transcriptions: number;
  };
  summary: { id: number } | null;
}

export interface CreateVoiceSampleData {
  memberId: string;
  label: string;
  audioPath: string;
  embedding: Buffer;
  embeddingModel: string;
  durationMs: number;
  source?: VoiceSampleSource;
}

/** Voice-library row without the binary embedding (safe to serialize to clients). */
export interface VoiceSampleListItem {
  id: string;
  label: string;
  durationMs: number;
  source: VoiceSampleSource;
  exemplarCount: number;
  createdAt: Date;
}

/** A speaker cluster enriched for the speaker-aware transcript view (SL-5). */
export interface SessionClusterView {
  id: string;
  clusterIdx: number;
  displayLabel: string;
  voiceSampleId: string | null;
  matchConfidence: string;
  matchedScore: number | null;
  snippetBlobPath: string | null;
  snippetAvailable: boolean;
  voiceLabel: string | null;
  playedByEmail: string | null;
  npcSuggestion: {
    id: string;
    suggestedName: string;
    confidence: string;
    reasoning: string;
    status: string;
  } | null;
}

/**
 * Thrown when a cluster tag is attempted but the cluster has already been
 * claimed (its `voiceSampleId` is no longer null). Lets concurrent tag /
 * NPC-accept requests fail closed instead of creating a duplicate voice.
 */
export class ClusterAlreadyTaggedError extends Error {
  constructor(clusterId: string) {
    super(`Cluster ${clusterId} is already tagged`);
    this.name = 'ClusterAlreadyTaggedError';
  }
}

export class DatabaseService {
  // Campaign operations
  async createCampaign(data: CreateCampaignData): Promise<Campaign> {
    // Create the campaign and its owner Member row together so that membership
    // is always the single source of truth for access checks.
    return prisma.$transaction(async (tx) => {
      const campaign = await tx.campaign.create({
        data: {
          name: data.name,
          description: data.description,
          systemPrompt: data.systemPrompt,
          userId: data.userId,
        },
      });
      await tx.member.create({
        data: {
          campaignId: campaign.id,
          userId: data.userId,
          role: 'owner',
        },
      });
      return campaign;
    });
  }
  
  async getCampaigns(userId?: string): Promise<(Campaign & { _count: { gamingSessions: number } })[]> {
    return prisma.campaign.findMany({
      // Include campaigns the user owns OR is a shared member of.
      where: userId
        ? { OR: [{ userId }, { members: { some: { userId } } }] }
        : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: { gamingSessions: true },
        },
      },
    });
  }
  
  async getCampaignById(id: string): Promise<Campaign | null> {
    return prisma.campaign.findUnique({
      where: { id },
    });
  }
  
  async updateCampaign(id: string, data: Partial<CreateCampaignData>): Promise<Campaign> {
    return prisma.campaign.update({
      where: { id },
      data: {
        name: data.name,
        description: data.description,
        systemPrompt: data.systemPrompt,
      },
    });
  }
  
  async deleteCampaign(id: string): Promise<void> {
    await prisma.campaign.delete({
      where: { id },
    });
  }
  
  // Session operations
  async createSession(data: CreateSessionData): Promise<GamingSession> {
    return prisma.gamingSession.create({
      data: {
        userId: data.userId,
        campaignId: data.campaignId,
        title: data.title,
        sessionDate: data.sessionDate,
        uploadId: data.uploadId,
        duration: data.duration,
        status: data.status || (data.uploadId ? 'uploaded' : 'draft'),
        ...(data.transcriptionMode && { transcriptionMode: data.transcriptionMode }),
      },
    });
  }
  
  async getSessions(userId?: string, campaignId?: string): Promise<SessionListItem[]> {
    return prisma.gamingSession.findMany({
      where: {
        ...(campaignId && { campaignId }),
        // Visible if the user owns or is a member of the session's campaign.
        ...(userId && {
          campaign: {
            OR: [{ userId }, { members: { some: { userId } } }],
          },
        }),
      },
      include: {
        campaign: {
          select: { id: true, name: true },
        },
        _count: {
          select: { transcriptions: true },
        },
        summary: {
          select: { id: true },
        },
      },
      orderBy: [{ sessionDate: 'desc' }, { createdAt: 'desc' }],
    });
  }
  
  async getSessionById(id: string): Promise<SessionWithIncludes | null> {
    return prisma.gamingSession.findUnique({
      where: { id },
      include: {
        campaign: {
          select: { id: true, name: true },
        },
        transcriptions: {
          orderBy: { startTime: 'asc' },
        },
        summary: true,
        upload: true,
      },
    });
  }
  
  
  async updateSessionStatus(id: string, status: string): Promise<GamingSession> {
    return prisma.gamingSession.update({
      where: { id },
      data: {
        status,
        updatedAt: new Date(),
      },
    });
  }
  
  async updateTranscriptionProgress(
    id: string,
    data: {
      currentStep?: string;
      totalChunks?: number;
      chunksCompleted?: number;
      transcriptionProgress?: number;
    }
  ): Promise<GamingSession> {
    return prisma.gamingSession.update({
      where: { id },
      data: {
        ...data,
        lastProgressAt: new Date(),
        updatedAt: new Date(),
      },
    });
  }
  
  async setSessionError(id: string, step: string, message: string): Promise<GamingSession> {
    return prisma.gamingSession.update({
      where: { id },
      data: {
        errorStep: step,
        errorMessage: message,
        lastError: new Date(),
        status: 'error',
        updatedAt: new Date(),
      },
    });
  }
  
  async clearSessionError(id: string): Promise<GamingSession> {
    return prisma.gamingSession.update({
      where: { id },
      data: {
        errorStep: null,
        errorMessage: null,
        lastError: null,
        updatedAt: new Date(),
      },
    });
  }

  async startProcessing(id: string): Promise<GamingSession> {
    return prisma.gamingSession.update({
      where: { id },
      data: {
        processingStartedAt: new Date(),
        lastProgressAt: new Date(),
        errorStep: null,
        errorMessage: null,
        lastError: null,
        updatedAt: new Date(),
      },
    });
  }

  async checkProcessingTimeout(id: string, timeoutMinutes: number = 30): Promise<{
    isTimedOut: boolean;
    minutesElapsed: number;
  }> {
    const session = await prisma.gamingSession.findUnique({
      where: { id },
      select: {
        processingStartedAt: true,
        lastProgressAt: true,
        status: true,
      },
    });

    if (!session || !session.processingStartedAt) {
      return { isTimedOut: false, minutesElapsed: 0 };
    }

    const now = new Date();
    const startTime = session.processingStartedAt;
    const minutesElapsed = (now.getTime() - startTime.getTime()) / (1000 * 60);
    const isTimedOut = minutesElapsed >= timeoutMinutes;

    return { isTimedOut, minutesElapsed: Math.floor(minutesElapsed) };
  }

  async cancelTranscription(id: string): Promise<GamingSession> {
    return prisma.gamingSession.update({
      where: { id },
      data: {
        status: 'uploaded',
        currentStep: null,
        totalChunks: null,
        chunksCompleted: 0,
        transcriptionProgress: 0,
        processingStartedAt: null,
        lastProgressAt: null,
        errorStep: null,
        errorMessage: null,
        lastError: null,
        updatedAt: new Date(),
      },
    });
  }
  
  async updateSession(id: string, data: {
    status?: string;
    errorStep?: string | null;
    errorMessage?: string | null;
    duration?: number;
    uploadId?: string | null;
  }): Promise<GamingSession> {
    return prisma.gamingSession.update({
      where: { id },
      data: {
        ...data,
        updatedAt: new Date(),
      },
    });
  }
  
  // Transcription operations
  async saveTranscriptions(sessionId: string, segments: { start: number; end: number; text: string; avg_logprob?: number }[]): Promise<void> {
    await prisma.$transaction(async (tx) => {
      // Delete existing transcriptions for this session
      await tx.transcription.deleteMany({
        where: { sessionId },
      });
      
      // Insert new transcriptions
      await tx.transcription.createMany({
        data: segments.map((segment) => ({
          sessionId,
          startTime: segment.start,
          endTime: segment.end,
          text: segment.text,
          confidence: segment.avg_logprob || 0,
        })),
      });
    });
  }

  async saveTranscription(sessionId: string, text: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
      // Delete existing transcriptions for this session
      await tx.transcription.deleteMany({
        where: { sessionId },
      });
      
      // Insert single transcription record with dummy timestamps
      await tx.transcription.create({
        data: {
          sessionId,
          startTime: 0,
          endTime: 0,
          text,
          confidence: null,
        },
      });
    });
  }
  
  async getTranscriptions(sessionId: string): Promise<Transcription[]> {
    return prisma.transcription.findMany({
      where: { sessionId },
      orderBy: { startTime: 'asc' },
    });
  }
  
  async getTranscriptionCount(sessionId: string): Promise<number> {
    return prisma.transcription.count({
      where: { sessionId },
    });
  }

  // Resumable transcription: per-chunk persistence + chunking signature
  async upsertTranscriptionChunk(sessionId: string, chunkIndex: number, text: string): Promise<void> {
    await prisma.transcriptionChunk.upsert({
      where: { sessionId_chunkIndex: { sessionId, chunkIndex } },
      create: { sessionId, chunkIndex, text },
      update: { text },
    });
  }

  async getTranscriptionChunks(sessionId: string): Promise<Map<number, string>> {
    const rows = await prisma.transcriptionChunk.findMany({
      where: { sessionId },
      select: { chunkIndex: true, text: true },
    });
    return new Map(rows.map((r) => [r.chunkIndex, r.text]));
  }

  async clearTranscriptionChunks(sessionId: string): Promise<void> {
    await prisma.transcriptionChunk.deleteMany({ where: { sessionId } });
  }

  async setTranscriptionChunkCount(sessionId: string, count: number | null): Promise<void> {
    await prisma.gamingSession.update({
      where: { id: sessionId },
      data: { transcriptionChunkCount: count, updatedAt: new Date() },
    });
  }

  async getTranscriptionChunkCount(sessionId: string): Promise<number | null> {
    const session = await prisma.gamingSession.findUnique({
      where: { id: sessionId },
      select: { transcriptionChunkCount: true },
    });
    return session?.transcriptionChunkCount ?? null;
  }
  
  // Summary operations
  async saveSummary(sessionId: string, summaryText: string): Promise<Summary> {
    return prisma.summary.upsert({
      where: { sessionId },
      update: {
        summaryText,
      },
      create: {
        sessionId,
        summaryText,
      },
    });
  }

  async updateSummary(sessionId: string, summaryText: string): Promise<Summary> {
    // First get the current summary to preserve original text
    const currentSummary = await prisma.summary.findUnique({
      where: { sessionId },
    });
    
    if (!currentSummary) {
      throw new Error('Summary not found');
    }
    
    return prisma.summary.update({
      where: { sessionId },
      data: {
        summaryText,
        isEdited: true,
        editedAt: new Date(),
        originalText: currentSummary.originalText || currentSummary.summaryText,
      },
    });
  }
  
  async getSummary(sessionId: string): Promise<Summary | null> {
    return prisma.summary.findUnique({
      where: { sessionId },
    });
  }

  // DM TODO List operations
  async saveDmTodoList(sessionId: string, content: string) {
    return prisma.dmTodoList.upsert({
      where: { sessionId },
      update: {
        content,
      },
      create: {
        sessionId,
        content,
      },
    });
  }

  async updateDmTodoList(sessionId: string, content: string) {
    // First get the current todo list to preserve original text
    const currentTodoList = await prisma.dmTodoList.findUnique({
      where: { sessionId },
    });

    if (!currentTodoList) {
      throw new Error('DM TODO list not found');
    }

    return prisma.dmTodoList.update({
      where: { sessionId },
      data: {
        content,
        isEdited: true,
        editedAt: new Date(),
        originalText: currentTodoList.originalText || currentTodoList.content,
      },
    });
  }

  async getDmTodoList(sessionId: string) {
    return prisma.dmTodoList.findUnique({
      where: { sessionId },
    });
  }

  // Upload operations
  async createUpload(data: CreateUploadData): Promise<Upload> {
    return prisma.upload.create({
      data: {
        userId: data.userId,
        filename: data.filename,
        originalName: data.originalName,
        path: data.path,
        size: data.size,
        mimetype: data.mimetype,
        duration: data.duration,
        storage: data.storage ?? 'blob',
        audioExpiresAt: data.audioExpiresAt ?? undefined,
        status: 'uploaded',
      },
    });
  }

  async getUploads(userId: string, includeSessions = false) {
    return prisma.upload.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      ...(includeSessions && {
        include: {
          gamingSessions: {
            select: {
              id: true,
              title: true,
              sessionDate: true,
              campaign: {
                select: {
                  name: true,
                },
              },
            },
          },
        },
      }),
    });
  }

  async getUploadById(id: string): Promise<Upload | null> {
    return prisma.upload.findUnique({
      where: { id },
    });
  }

  async updateUploadStatus(id: string, status: string, chunkPaths?: string[]): Promise<Upload> {
    return prisma.upload.update({
      where: { id },
      data: {
        status,
        chunkPaths: chunkPaths ? JSON.stringify(chunkPaths) : undefined,
        updatedAt: new Date(),
      },
    });
  }

  async deleteUpload(id: string): Promise<void> {
    await prisma.upload.delete({
      where: { id },
    });
  }

  async getUploadUsage(id: string): Promise<{ sessionCount: number; sessions: GamingSession[] }> {
    const sessions = await prisma.gamingSession.findMany({
      where: { uploadId: id },
      include: {
        campaign: {
          select: { name: true },
        },
      },
    });

    return {
      sessionCount: sessions.length,
      sessions,
    };
  }

  async linkSessionToUpload(sessionId: string, uploadId: string): Promise<GamingSession> {
    return prisma.gamingSession.update({
      where: { id: sessionId },
      data: {
        uploadId,
        status: 'uploaded',
        updatedAt: new Date(),
      },
    });
  }

  async unlinkSessionFromUpload(sessionId: string): Promise<GamingSession> {
    return prisma.gamingSession.update({
      where: { id: sessionId },
      data: {
        uploadId: null,
        status: 'draft',
        updatedAt: new Date(),
      },
    });
  }
  
  // Utility methods
  async deleteSession(id: string): Promise<void> {
    await prisma.gamingSession.delete({
      where: { id },
    });
  }
  
  async getTotalSpeechTime(sessionId: string): Promise<number> {
    const result = await prisma.transcription.aggregate({
      where: { sessionId },
      _sum: {
        endTime: true,
        startTime: true,
      },
    });
    
    return (result._sum.endTime || 0) - (result._sum.startTime || 0);
  }
  
  async getSessionStats(userId?: string): Promise<{
    totalSessions: number;
    completedSessions: number;
    totalCampaigns: number;
  }> {
    const where = userId ? { campaign: { userId } } : undefined;
    const campaignWhere = userId ? { userId } : undefined;
    
    const [totalSessions, completedSessions, totalCampaigns] = await Promise.all([
      prisma.gamingSession.count({ where }),
      prisma.gamingSession.count({ where: { ...where, status: 'completed' } }),
      prisma.campaign.count({ where: campaignWhere }),
    ]);
    
    return {
      totalSessions,
      completedSessions,
      totalCampaigns,
    };
  }

  // Voice-library (speaker-labels) operations

  /** The caller's Member id within a campaign, or null if they aren't a member. */
  async getMemberId(campaignId: string, userId: string): Promise<string | null> {
    const member = await prisma.member.findUnique({
      where: { campaignId_userId: { campaignId, userId } },
      select: { id: true },
    });
    return member?.id ?? null;
  }

  async createVoiceSample(data: CreateVoiceSampleData): Promise<VoiceSample> {
    return prisma.voiceSample.create({
      data: {
        memberId: data.memberId,
        label: data.label,
        audioPath: data.audioPath,
        embedding: new Uint8Array(data.embedding),
        embeddingModel: data.embeddingModel,
        durationMs: data.durationMs,
        source: data.source ?? 'enrolled',
      },
    });
  }

  /** A member's voice samples, newest first, without the binary embedding. */
  /** Number of enrolled voices across the whole campaign (any member). */
  async countVoiceSamplesByCampaign(campaignId: string): Promise<number> {
    return prisma.voiceSample.count({
      where: { member: { campaignId } },
    });
  }

  async listVoiceSamplesByMember(memberId: string): Promise<VoiceSampleListItem[]> {
    return prisma.voiceSample.findMany({
      where: { memberId },
      select: {
        id: true,
        label: true,
        durationMs: true,
        source: true,
        exemplarCount: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Full row including the owning member's userId, for ownership checks. */
  async getVoiceSampleWithOwner(
    id: string,
  ): Promise<(VoiceSample & { member: { userId: string; campaignId: string } }) | null> {
    return prisma.voiceSample.findUnique({
      where: { id },
      include: { member: { select: { userId: true, campaignId: true } } },
    });
  }

  async deleteVoiceSample(id: string): Promise<void> {
    await prisma.voiceSample.delete({ where: { id } });
  }

  // Diarization + self-refining-fingerprint operations

  /** Queue a diarization run for a session and mark it queued. Returns the job. */
  async createDiarizationJob(sessionId: string): Promise<DiarizationJob> {
    const hmacSecret = randomBytes(32).toString('hex');
    const [job] = await prisma.$transaction([
      prisma.diarizationJob.create({ data: { sessionId, status: 'queued', hmacSecret } }),
      prisma.gamingSession.update({
        where: { id: sessionId },
        data: { diarizationStatus: 'queued' },
      }),
    ]);
    return job;
  }

  async getDiarizationJobById(
    jobId: string,
  ): Promise<(DiarizationJob & { session: GamingSession }) | null> {
    return prisma.diarizationJob.findUnique({
      where: { id: jobId },
      include: { session: true },
    });
  }

  async updateDiarizationJob(
    jobId: string,
    data: {
      status?: DiarizationStatus;
      aciResourceId?: string | null;
      region?: string | null;
      startedAt?: Date | null;
      finishedAt?: Date | null;
      errorMessage?: string | null;
      costEstimateUsd?: number | null;
      incrementAttempt?: boolean;
    },
  ): Promise<DiarizationJob> {
    const { incrementAttempt, ...rest } = data;
    return prisma.diarizationJob.update({
      where: { id: jobId },
      data: {
        ...rest,
        ...(incrementAttempt && { attemptCount: { increment: 1 } }),
      },
    });
  }

  /** Count diarization jobs currently in the `running` state (system-wide). */
  async countRunningDiarizationJobs(): Promise<number> {
    return prisma.diarizationJob.count({ where: { status: 'running' } });
  }

  /** Count `running` diarization jobs whose session belongs to a campaign. */
  async countRunningDiarizationJobsByCampaign(campaignId: string): Promise<number> {
    return prisma.diarizationJob.count({
      where: { status: 'running', session: { campaignId } },
    });
  }

  /**
   * Sum the estimated cost of jobs started on/after `since` (the daily-budget
   * accumulator). Only running/completed jobs carry a committed cost estimate.
   */
  async sumDiarizationCostSince(since: Date): Promise<number> {
    const result = await prisma.diarizationJob.aggregate({
      _sum: { costEstimateUsd: true },
      where: { startedAt: { gte: since } },
    });
    return result._sum.costEstimateUsd ? Number(result._sum.costEstimateUsd) : 0;
  }

  /**
   * Oldest-first queued jobs awaiting dispatch, with the session campaignId +
   * upload (path/storage) the dispatcher needs to mint a read SAS.
   */
  async listQueuedDiarizationJobs(
    limit = 20,
  ): Promise<
    (DiarizationJob & { session: GamingSession & { upload: Upload | null } })[]
  > {
    return prisma.diarizationJob.findMany({
      where: { status: 'queued' },
      include: { session: { include: { upload: true } } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  /**
   * Atomically claim a queued job for dispatch by flipping it queued -> running.
   * Returns true iff this caller won the claim (guards against double-dispatch
   * by concurrent dispatcher ticks). Does NOT yet set aci/region/cost — the
   * caller fills those in once a container is accepted, or reverts on failure.
   */
  async claimDiarizationJobForDispatch(jobId: string): Promise<boolean> {
    const { count } = await prisma.diarizationJob.updateMany({
      where: { id: jobId, status: 'queued' },
      data: { status: 'running', startedAt: new Date(), attemptCount: { increment: 1 } },
    });
    if (count > 0) {
      const job = await prisma.diarizationJob.findUnique({
        where: { id: jobId },
        select: { sessionId: true },
      });
      if (job) {
        await prisma.gamingSession.update({
          where: { id: job.sessionId },
          data: { diarizationStatus: 'running' },
        });
      }
    }
    return count > 0;
  }

  /** Running jobs that have an ACI resource (cleanup-loop candidates). */
  async listRunningDiarizationJobsWithAci(): Promise<DiarizationJob[]> {
    return prisma.diarizationJob.findMany({
      where: { status: 'running', aciResourceId: { not: null } },
    });
  }

  /**
   * Revert a failed dispatch attempt back to `queued` so a later tick can retry
   * (used when no region accepted the container). Clears any partial aci/region.
   */
  async revertDiarizationJobToQueued(jobId: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const job = await tx.diarizationJob.update({
        where: { id: jobId },
        data: { status: 'queued', aciResourceId: null, region: null, startedAt: null },
      });
      await tx.gamingSession.update({
        where: { id: job.sessionId },
        data: { diarizationStatus: 'queued' },
      });
    });
  }

  /** Permanently fail a diarization job and mirror the status onto its session. */
  async failDiarizationJob(jobId: string, errorMessage: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const job = await tx.diarizationJob.update({
        where: { id: jobId },
        data: { status: 'failed', finishedAt: new Date(), errorMessage },
      });
      await tx.gamingSession.update({
        where: { id: job.sessionId },
        data: { diarizationStatus: 'failed' },
      });
    });
  }


  /**
   * All voices in a campaign as match-ready fingerprints: each voice's seed
   * embedding followed by its learned exemplars (per the self-refining design).
   */
  async getCampaignFingerprints(campaignId: string): Promise<VoiceFingerprint[]> {
    const samples = await prisma.voiceSample.findMany({
      where: { member: { campaignId } },
      select: {
        id: true,
        label: true,
        memberId: true,
        embedding: true,
        exemplars: { select: { embedding: true } },
      },
    });
    return samples.map((s) => ({
      voiceSampleId: s.id,
      memberId: s.memberId,
      label: s.label,
      embeddings: [
        deserializeEmbedding(Buffer.from(s.embedding)),
        ...s.exemplars.map((e) => deserializeEmbedding(Buffer.from(e.embedding))),
      ],
    }));
  }

  async upsertSpeakerCluster(data: {
    sessionId: string;
    campaignId: string;
    clusterIdx: number;
    embeddingCentroid: Buffer;
    segmentCount: number;
    totalDurationMs: number;
    displayLabel: string;
    voiceSampleId: string | null;
    matchConfidence: string;
    matchedScore: number | null;
    snippetBlobPath?: string | null;
    snippetExpiresAt?: Date | null;
  }): Promise<SessionSpeakerCluster> {
    const embedding = new Uint8Array(data.embeddingCentroid);
    return prisma.sessionSpeakerCluster.upsert({
      where: { sessionId_clusterIdx: { sessionId: data.sessionId, clusterIdx: data.clusterIdx } },
      create: {
        sessionId: data.sessionId,
        campaignId: data.campaignId,
        clusterIdx: data.clusterIdx,
        embeddingCentroid: embedding,
        segmentCount: data.segmentCount,
        totalDurationMs: data.totalDurationMs,
        displayLabel: data.displayLabel,
        voiceSampleId: data.voiceSampleId,
        matchConfidence: data.matchConfidence,
        matchedScore: data.matchedScore,
        snippetBlobPath: data.snippetBlobPath ?? null,
        snippetExpiresAt: data.snippetExpiresAt ?? null,
      },
      update: {
        embeddingCentroid: embedding,
        segmentCount: data.segmentCount,
        totalDurationMs: data.totalDurationMs,
        displayLabel: data.displayLabel,
        voiceSampleId: data.voiceSampleId,
        matchConfidence: data.matchConfidence,
        matchedScore: data.matchedScore,
        snippetBlobPath: data.snippetBlobPath ?? null,
        snippetExpiresAt: data.snippetExpiresAt ?? null,
      },
    });
  }

  /**
   * Atomically finalize a completed diarization run: replace the session's
   * transcriptions with the speaker-attributed segments, mark the session
   * completed + needing re-summarization, and complete the job — all in one
   * transaction so a crash can't leave the session and job in disagreeing
   * states.
   */
  async completeDiarizationJob(args: {
    sessionId: string;
    jobId: string;
    uploadId?: string | null;
    rows: { startTime: number; endTime: number; text: string; confidence: number | null; speakerClusterId: string }[];
  }): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.transcription.deleteMany({ where: { sessionId: args.sessionId } });
      if (args.rows.length > 0) {
        await tx.transcription.createMany({
          data: args.rows.map((r) => ({
            sessionId: args.sessionId,
            startTime: r.startTime,
            endTime: r.endTime,
            text: r.text,
            confidence: r.confidence,
            speakerClusterId: r.speakerClusterId,
          })),
        });
      }
      await tx.gamingSession.update({
        where: { id: args.sessionId },
        data: { diarizationStatus: 'completed', needsResummarize: true },
      });
      await tx.diarizationJob.update({
        where: { id: args.jobId },
        data: { status: 'completed', finishedAt: new Date(), attemptCount: { increment: 1 } },
      });
      // Speaker-labeled audio enters its retention window once diarized.
      if (args.uploadId) {
        await tx.upload.update({
          where: { id: args.uploadId },
          data: { audioExpiresAt: new Date(Date.now() + getRetentionConfig().audioRetentionMs) },
        });
      }
    });
  }

  /**
   * Fold a high-confidence cluster centroid into a voice's fingerprint as a
   * learned exemplar. Idempotent per source session (upsert), and evicts the
   * oldest exemplars past the cap. Keeps `exemplarCount` in sync.
   */
  async addLearnedExemplar(args: {
    voiceSampleId: string;
    embedding: Buffer;
    embeddingModel: string;
    source: VoiceExemplarSource;
    sourceSessionId: string;
    similarityAtCapture: number | null;
    durationMs: number;
    maxExemplars: number;
  }): Promise<void> {
    await prisma.$transaction((tx) => this.addLearnedExemplarTx(tx, args));
  }

  /** Exemplar-learning body, run against a caller-supplied transaction client. */
  private async addLearnedExemplarTx(
    tx: Prisma.TransactionClient,
    args: {
      voiceSampleId: string;
      embedding: Buffer;
      embeddingModel: string;
      source: VoiceExemplarSource;
      sourceSessionId: string;
      similarityAtCapture: number | null;
      durationMs: number;
      maxExemplars: number;
    },
  ): Promise<void> {
    const embedding = new Uint8Array(args.embedding);
    await tx.voiceExemplar.upsert({
      where: {
        voiceSampleId_sourceSessionId: {
          voiceSampleId: args.voiceSampleId,
          sourceSessionId: args.sourceSessionId,
        },
      },
      create: {
        voiceSampleId: args.voiceSampleId,
        embedding,
        embeddingModel: args.embeddingModel,
        source: args.source,
        sourceSessionId: args.sourceSessionId,
        similarityAtCapture: args.similarityAtCapture,
        durationMs: args.durationMs,
      },
      update: {
        embedding,
        embeddingModel: args.embeddingModel,
        source: args.source,
        similarityAtCapture: args.similarityAtCapture,
        durationMs: args.durationMs,
      },
    });

    const all = await tx.voiceExemplar.findMany({
      where: { voiceSampleId: args.voiceSampleId },
      select: { id: true, createdAt: true },
    });
    const toEvict = selectExemplarsToEvict(all, args.maxExemplars);
    if (toEvict.length > 0) {
      await tx.voiceExemplar.deleteMany({ where: { id: { in: toEvict } } });
    }
    await tx.voiceSample.update({
      where: { id: args.voiceSampleId },
      data: { exemplarCount: all.length - toEvict.length },
    });
  }

  async setSessionDiarizationStatus(
    sessionId: string,
    status: DiarizationStatus,
    opts: { needsResummarize?: boolean } = {},
  ): Promise<void> {
    await prisma.gamingSession.update({
      where: { id: sessionId },
      data: {
        diarizationStatus: status,
        ...(opts.needsResummarize !== undefined && { needsResummarize: opts.needsResummarize }),
      },
    });
  }

  // ---- Speaker-labels: transcript view, tag cascade, NPC suggestions (SL-5) ----

  /** Clusters for a session, enriched for the speaker-aware transcript view. */
  async getSessionClusters(sessionId: string): Promise<SessionClusterView[]> {
    const clusters = await prisma.sessionSpeakerCluster.findMany({
      where: { sessionId },
      orderBy: { clusterIdx: 'asc' },
      include: {
        voiceSample: { include: { member: { include: { user: { select: { email: true } } } } } },
        npcSuggestion: true,
      },
    });
    const now = Date.now();
    return clusters.map((c) => ({
      id: c.id,
      clusterIdx: c.clusterIdx,
      displayLabel: c.displayLabel,
      voiceSampleId: c.voiceSampleId,
      matchConfidence: c.matchConfidence,
      matchedScore: c.matchedScore,
      snippetBlobPath: c.snippetBlobPath,
      snippetAvailable:
        !!c.snippetBlobPath && (!c.snippetExpiresAt || c.snippetExpiresAt.getTime() > now),
      voiceLabel: c.voiceSample?.label ?? null,
      playedByEmail: c.voiceSample?.member.user.email ?? null,
      npcSuggestion: c.npcSuggestion
        ? {
            id: c.npcSuggestion.id,
            suggestedName: c.npcSuggestion.suggestedName,
            confidence: c.npcSuggestion.confidence,
            reasoning: c.npcSuggestion.reasoning,
            status: c.npcSuggestion.status,
          }
        : null,
    }));
  }

  /** Campaign voices for the "maybe one of these?" tag dropdown. */
  async getCampaignVoiceOptions(campaignId: string): Promise<{ id: string; label: string }[]> {
    const samples = await prisma.voiceSample.findMany({
      where: { member: { campaignId } },
      select: { id: true, label: true },
      orderBy: { label: 'asc' },
    });
    return samples;
  }

  /** A cluster plus the data needed to authorize + run the tag cascade. */
  async getClusterForTagging(clusterId: string): Promise<
    | (SessionSpeakerCluster & { session: { campaignId: string } })
    | null
  > {
    return prisma.sessionSpeakerCluster.findUnique({
      where: { id: clusterId },
      include: { session: { select: { campaignId: true } } },
    });
  }

  /**
   * Link an unknown cluster to an EXISTING campaign voice (manual tag). Sets the
   * label, folds the cluster centroid in as a DM-confirmed exemplar (learning),
   * and flags the session for re-summarization.
   */
  async tagClusterWithExistingVoice(
    clusterId: string,
    voiceSampleId: string,
    sessionId: string,
  ): Promise<void> {
    const voice = await prisma.voiceSample.findUnique({
      where: { id: voiceSampleId },
      select: { label: true },
    });
    if (!voice) throw new Error('Voice sample not found');
    const cluster = await prisma.sessionSpeakerCluster.findUnique({
      where: { id: clusterId },
      select: { embeddingCentroid: true, matchedScore: true, totalDurationMs: true },
    });
    if (!cluster) throw new Error('Cluster not found');

    await prisma.$transaction(async (tx) => {
      // Claim the cluster only if still untagged — fail closed on a concurrent tag.
      const claimed = await tx.sessionSpeakerCluster.updateMany({
        where: { id: clusterId, voiceSampleId: null },
        data: { voiceSampleId, displayLabel: voice.label, matchConfidence: 'high' },
      });
      if (claimed.count === 0) throw new ClusterAlreadyTaggedError(clusterId);

      await this.addLearnedExemplarTx(tx, {
        voiceSampleId,
        embedding: Buffer.from(cluster.embeddingCentroid),
        embeddingModel: 'ecapa-tdnn-v1',
        source: 'dm_confirmed',
        sourceSessionId: sessionId,
        similarityAtCapture: cluster.matchedScore,
        durationMs: cluster.totalDurationMs,
        maxExemplars: getFingerprintConfig().maxExemplars,
      });
      await tx.gamingSession.update({
        where: { id: sessionId },
        data: { needsResummarize: true },
      });
    });
  }

  /**
   * Tag an unknown cluster with a NEW name (lazy-tagging cascade, design §3):
   * promote the cluster's snippet to a new VoiceSample, link the cluster, then
   * scan all still-unknown clusters campaign-wide and auto-link any that match
   * the new voice. Every affected session is flagged for re-summarization.
   * Returns the new sample id and the affected session ids.
   */
  async tagClusterWithNewName(args: {
    clusterId: string;
    name: string;
    memberId: string;
    campaignId: string;
  }): Promise<{ voiceSampleId: string; affectedSessionIds: string[] }> {
    const cluster = await prisma.sessionSpeakerCluster.findUnique({
      where: { id: args.clusterId },
    });
    if (!cluster) throw new Error('Cluster not found');

    const newEmbedding = deserializeEmbedding(Buffer.from(cluster.embeddingCentroid));
    const threshold = getFingerprintConfig().matchThreshold;

    return prisma.$transaction(async (tx) => {
      const sample = await tx.voiceSample.create({
        data: {
          memberId: args.memberId,
          label: args.name,
          audioPath: cluster.snippetBlobPath ?? '',
          embedding: new Uint8Array(cluster.embeddingCentroid),
          embeddingModel: 'ecapa-tdnn-v1',
          durationMs: cluster.totalDurationMs,
          source: 'tagged_from_cluster',
          originalClusterId: cluster.id,
        },
      });

      // Link + promote this cluster (its snippet is now the voice's audio).
      // Conditional on still-untagged so a concurrent tag/NPC-accept can't create
      // a second voice for the same cluster — the loser rolls this whole txn back.
      const claimed = await tx.sessionSpeakerCluster.updateMany({
        where: { id: cluster.id, voiceSampleId: null },
        data: {
          voiceSampleId: sample.id,
          displayLabel: args.name,
          matchConfidence: 'high',
          snippetExpiresAt: null,
        },
      });
      if (claimed.count === 0) throw new ClusterAlreadyTaggedError(cluster.id);

      // Cascade: auto-link other still-unknown clusters in the campaign.
      const candidates = await tx.sessionSpeakerCluster.findMany({
        where: { campaignId: args.campaignId, voiceSampleId: null, id: { not: cluster.id } },
        select: { id: true, sessionId: true, embeddingCentroid: true },
      });
      const affected = new Set<string>([cluster.sessionId]);
      for (const cand of candidates) {
        const score = cosineSimilarity(
          newEmbedding,
          deserializeEmbedding(Buffer.from(cand.embeddingCentroid)),
        );
        if (score >= threshold) {
          await tx.sessionSpeakerCluster.update({
            where: { id: cand.id },
            data: {
              voiceSampleId: sample.id,
              displayLabel: args.name,
              matchConfidence: 'high',
              matchedScore: score,
            },
          });
          affected.add(cand.sessionId);
        }
      }

      await tx.gamingSession.updateMany({
        where: { id: { in: [...affected] } },
        data: { needsResummarize: true },
      });

      return { voiceSampleId: sample.id, affectedSessionIds: [...affected] };
    });
  }

  /** Insert NPC suggestions, skipping clusters that already have one. */
  async createNpcSuggestions(
    sessionId: string,
    items: { clusterId: string; suggestedName: string; confidence: string; reasoning: string }[],
  ): Promise<number> {
    if (items.length === 0) return 0;
    const result = await prisma.sessionNpcSuggestion.createMany({
      data: items.map((i) => ({
        sessionId,
        clusterId: i.clusterId,
        suggestedName: i.suggestedName,
        confidence: i.confidence,
        reasoning: i.reasoning,
      })),
      skipDuplicates: true,
    });
    return result.count;
  }

  async getNpcSuggestionById(
    id: string,
  ): Promise<(SessionNpcSuggestion & { session: { campaignId: string } }) | null> {
    return prisma.sessionNpcSuggestion.findUnique({
      where: { id },
      include: { session: { select: { campaignId: true } } },
    });
  }

  /**
   * Atomically resolve a suggestion only if still pending. Returns false when it
   * was already resolved (lost a concurrent race), so callers can fail closed.
   */
  async resolveNpcSuggestion(
    id: string,
    status: 'accepted' | 'rejected',
    userId: string,
  ): Promise<boolean> {
    const result = await prisma.sessionNpcSuggestion.updateMany({
      where: { id, status: 'pending' },
      data: { status, resolvedAt: new Date(), resolvedBy: userId },
    });
    return result.count > 0;
  }

  /** Clear the re-summarize banner flag (after a successful re-summary). */
  async clearNeedsResummarize(sessionId: string): Promise<void> {
    await prisma.gamingSession.update({
      where: { id: sessionId },
      data: { needsResummarize: false },
    });
  }

  // ── Retention (speaker-labels cron) ───────────────────────────────────────

  /** Uploads whose session audio has passed its retention window. */
  async getExpiredAudioUploads(
    now: Date,
  ): Promise<{ id: string; path: string; storage: UploadStorage }[]> {
    return prisma.upload.findMany({
      where: { audioExpiresAt: { not: null, lt: now } },
      select: { id: true, path: true, storage: true },
    });
  }

  /** Mark an upload's audio as purged: clears the expiry and tombstones status. */
  async markAudioPurged(uploadId: string): Promise<void> {
    await prisma.upload.update({
      where: { id: uploadId },
      data: { audioExpiresAt: null, status: 'cleaned' },
    });
  }

  /** Unknown-cluster snippets whose review window has elapsed (never tagged). */
  async getExpiredSnippetClusters(
    now: Date,
  ): Promise<{ id: string; snippetBlobPath: string }[]> {
    const rows = await prisma.sessionSpeakerCluster.findMany({
      where: { snippetExpiresAt: { not: null, lt: now }, snippetBlobPath: { not: null } },
      select: { id: true, snippetBlobPath: true },
    });
    return rows.filter(
      (r): r is { id: string; snippetBlobPath: string } =>
        r.snippetBlobPath !== null && r.snippetBlobPath.trim() !== '',
    );
  }

  /** Drop a cluster's expired snippet (leaves the cluster row in place). */
  async clearClusterSnippet(clusterId: string): Promise<void> {
    await prisma.sessionSpeakerCluster.update({
      where: { id: clusterId },
      data: { snippetBlobPath: null, snippetExpiresAt: null },
    });
  }

  async setNpcInferenceStatus(
    sessionId: string,
    status: 'none' | 'pending' | 'completed' | 'failed',
  ): Promise<void> {
    await prisma.gamingSession.update({
      where: { id: sessionId },
      data: { npcInferenceStatus: status },
    });
  }

  /**
   * Atomically transition NPC inference into 'pending', but only from a state
   * where a fresh run is allowed ('none' or 'failed'). Returns false when the
   * session is already 'pending' or 'completed', so inference runs at most once.
   */
  async claimNpcInference(sessionId: string): Promise<boolean> {
    const result = await prisma.gamingSession.updateMany({
      where: { id: sessionId, npcInferenceStatus: { in: ['none', 'failed'] } },
      data: { npcInferenceStatus: 'pending' },
    });
    return result.count > 0;
  }

  // User operations (for test cleanup)
  async getUserByEmail(email: string) {
    return prisma.user.findUnique({
      where: { email },
    });
  }

  async deleteUser(userId: string): Promise<void> {
    // Prisma will cascade delete all related records (campaigns, sessions, uploads, etc.)
    await prisma.user.delete({
      where: { id: userId },
    });
  }
}

// Create singleton instance
export const db = new DatabaseService();
export default db;