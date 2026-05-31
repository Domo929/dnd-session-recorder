import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth-utils';
import { getCampaignAccess, requireSessionAccess } from '@/lib/permissions';
import { db } from '@/services/database';
import { generateAiText, isAiMocked } from '@/lib/ai';
import { buildSpeakerContext, buildSpeakerSummaryPrompt, type SpeakerContext } from '@/services/speakerContext';
import { buildNpcInferencePrompt, parseNpcSuggestions } from '@/lib/npcInference';
import { reindexSession } from '@/services/campaignIndex';
import { isTestAccount } from '@/lib/whitelist';
import { logger } from '@/lib/logger';

const updateSummarySchema = z.object({
  summary_text: z.string().min(1, 'Summary text is required'),
});

// Helper to update session status
async function updateSessionStatus(sessionId: string, status: string, errorStep?: string, errorMessage?: string): Promise<void> {
  try {
    await db.updateSession(sessionId, {
      status,
      errorStep: errorStep || null,
      errorMessage: errorMessage || null,
    });
  } catch (error) {
    logger.error('Failed to update session status', error as Error, { sessionId });
    throw error;
  }
}

// Helper to format transcriptions for summary
function formatTranscriptionsForSummary(transcriptions: Array<{ text: string }>): string {
  return transcriptions
    .map(t => t.text)
    .join(' ');
}

/**
 * NPC inference pass (design Section 5): infer names for unidentified clusters
 * and store them as pending suggestions. Runs at most once per session and only
 * when the campaign opted in and there is at least one unidentified cluster.
 * Best-effort: any failure is logged and swallowed so the summary still
 * succeeds.
 */
async function runNpcInference(
  sessionId: string,
  enabled: boolean,
  ctx: SpeakerContext,
): Promise<void> {
  if (!enabled || ctx.unknownLabels.length === 0) return;

  // Atomically claim the run (none|failed → pending). A lost race (already
  // pending/completed) returns false, so inference never double-runs.
  const claimed = await db.claimNpcInference(sessionId);
  if (!claimed) return;

  try {
    const prompt = buildNpcInferencePrompt({ unknownLabels: ctx.unknownLabels, turns: ctx.turns });
    const { text } = await generateAiText(prompt, 'npc-inference');
    const suggestions = parseNpcSuggestions(text, ctx.unknownLabels);

    // Map the model's label back to the cluster id.
    const clusterIdByLabel = new Map(ctx.clusters.map((c) => [c.displayLabel, c.id]));
    const rows = suggestions
      .map((s) => {
        const clusterId = clusterIdByLabel.get(s.label);
        if (!clusterId) return null;
        return {
          clusterId,
          suggestedName: s.suggestedName,
          confidence: s.confidence,
          reasoning: s.reasoning,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    if (rows.length > 0) await db.createNpcSuggestions(sessionId, rows);
    await db.setNpcInferenceStatus(sessionId, 'completed');
    logger.info('NPC inference completed', { sessionId, suggestions: rows.length });
  } catch (err) {
    logger.error('NPC inference failed', err as Error, { sessionId });
    await db.setNpcInferenceStatus(sessionId, 'failed').catch(() => {});
  }
}

// POST /api/summary/[sessionId] - Generate summary
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  // Optional { regenerate: true } forces a fresh summary (cost-aware re-summarize).
  let regenerate = false;
  try {
    const body = await request.json();
    regenerate = body?.regenerate === true;
  } catch {
    // No/non-JSON body — treat as a normal (idempotent) generation.
  }

  try {
    // Check authentication and get user info
    const { error: authError, user } = await requireAuth();
    if (authError) return authError;

    // COST PROTECTION: Block test accounts from making real AI API calls.
    // Skipped when AI is mocked — no spend, so the pipeline can be tested.
    if (isTestAccount(user.email!) && !isAiMocked()) {
      logger.warn('Blocked test account from summary generation', {
        sessionId,
        userEmail: user.email
      });

      return NextResponse.json(
        {
          error: 'Test accounts cannot use AI summary services. Please use a real email address to access this feature.',
          isTestAccount: true
        },
        { status: 403 }
      );
    }

    // Check if session exists
    const session = await db.getSessionById(sessionId);
    if (!session) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    // Only the campaign owner may trigger (re)generation — it incurs AI spend.
    const role = await getCampaignAccess(user.id, session.campaignId);
    if (role !== 'owner') {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    // IDEMPOTENCY: skip if a summary already exists, UNLESS regenerating.
    const existingSummary = await db.getSummary(sessionId);
    if (existingSummary && !regenerate) {
      logger.info('Summary already exists, skipping', { sessionId });

      // Update status to completed if not already
      if (session.status !== 'completed') {
        await updateSessionStatus(sessionId, 'completed');
      }

      return NextResponse.json({
        message: 'Summary already exists',
        summary: existingSummary.summaryText,
        skipped: true
      });
    }

    // Get campaign information to include system prompt
    const campaign = await db.getCampaignById(session.campaignId);
    if (!campaign) {
      return NextResponse.json(
        { error: 'Campaign not found' },
        { status: 404 }
      );
    }

    // Get transcriptions for this session
    const transcriptions = await db.getTranscriptions(sessionId);

    if (!transcriptions || transcriptions.length === 0) {
      return NextResponse.json(
        { error: 'No transcriptions found for this session' },
        { status: 400 }
      );
    }

    logger.info('Starting summary generation', { sessionId, regenerate });
    await updateSessionStatus(sessionId, 'summarizing');

    // Speaker-aware summary when diarization produced labeled clusters;
    // otherwise the original plain-transcript prompt.
    const speakerLabeled =
      session.transcriptionMode === 'speaker_labeled' && session.diarizationStatus === 'completed';
    let speakerContext: SpeakerContext | null = null;
    let prompt: string;

    if (speakerLabeled) {
      speakerContext = await buildSpeakerContext(sessionId);
      prompt = buildSpeakerSummaryPrompt({
        roster: speakerContext.roster,
        turns: speakerContext.turns,
        campaignSystemPrompt: campaign.systemPrompt,
      });
    } else {
      const formattedText = formatTranscriptionsForSummary(transcriptions);
      let basePrompt = `You are a skilled storyteller and D&D campaign chronicler. Below is a transcript of a D&D session. Please create an engaging summary that:

1. Tells the story of what happened in this session
2. Identifies key events, decisions, and character moments
3. Mentions which characters were involved in important scenes
4. Maintains the narrative flow and excitement of the session
5. Uses the character names provided
6. Focuses on story elements, combat highlights, and character development`;

      if (campaign.systemPrompt) {
        basePrompt += `\n\nCampaign Context:\n${campaign.systemPrompt}`;
      }

      basePrompt += `\n\nHere's the transcript:\n\n${formattedText}\n\nPlease provide a compelling summary that captures the essence of this D&D session.`;
      prompt = basePrompt;
    }

    // Generate summary via the AI service wrapper
    const { text: summaryText } = await generateAiText(prompt, 'summary');

    // Save (or overwrite, when regenerating) the summary.
    if (existingSummary) {
      await db.updateSummary(sessionId, summaryText);
    } else {
      await db.saveSummary(sessionId, summaryText);
    }
    await db.clearNeedsResummarize(sessionId);
    await updateSessionStatus(sessionId, 'completed');

    // NPC inference pass: once, when there are unidentified clusters and the
    // campaign opted in. Best-effort — never fails the summary.
    if (speakerLabeled && speakerContext) {
      await runNpcInference(sessionId, campaign.npcInferenceEnabled, speakerContext);
    }

    // Index this session's content for campaign search/chat. Best-effort —
    // a failure here must never fail summary generation.
    try {
      await reindexSession(sessionId);
    } catch (err) {
      logger.error('Campaign reindex failed', err as Error, { sessionId });
    }

    logger.info('Summary generation completed', { sessionId });

    return NextResponse.json({
      message: 'Summary generated successfully',
      summary: summaryText
    });

  } catch (error) {
    logger.error('Summary generation error', error as Error, { sessionId });
    await updateSessionStatus(
      sessionId,
      'error',
      'summary',
      error instanceof Error ? error.message : String(error)
    );

    return NextResponse.json(
      { error: 'Failed to generate summary' },
      { status: 500 }
    );
  }
}

// GET /api/summary/[sessionId] - Get summary for a session
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  try {
    // Any member of the session's campaign may read its summary.
    const access = await requireSessionAccess(sessionId, 'any');
    if (!access.ok) return access.response;

    const summary = await db.getSummary(sessionId);

    if (!summary) {
      return NextResponse.json(
        { error: 'Summary not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(summary);
  } catch (error) {
    logger.error('Failed to fetch summary', error as Error);

    return NextResponse.json(
      { error: 'Failed to fetch summary' },
      { status: 500 }
    );
  }
}

// PUT /api/summary/[sessionId] - Update summary for a session
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  
  try {
    // Check authentication
    const { error: authError, user } = await requireAuth();
    if (authError) return authError;

    const body = await request.json();
    const validatedData = updateSummarySchema.parse(body);

    // Verify session exists and belongs to user
    const gamingSession = await db.getSessionById(sessionId);
    if (!gamingSession) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    // Check if user owns the campaign this session belongs to
    const campaign = await db.getCampaignById(gamingSession.campaignId);
    if (!campaign || campaign.userId !== user.id) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }
    
    // Verify summary exists
    const existingSummary = await db.getSummary(sessionId);
    if (!existingSummary) {
      return NextResponse.json(
        { error: 'Summary not found' },
        { status: 404 }
      );
    }
    
    // Update summary
    const updatedSummary = await db.updateSummary(sessionId, validatedData.summary_text);

    logger.info('Summary updated', { sessionId });
    
    return NextResponse.json({
      message: 'Summary updated successfully',
      summary: updatedSummary
    });
    
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation error', details: error.issues },
        { status: 400 }
      );
    }

    logger.error('Failed to update summary', error as Error);

    return NextResponse.json(
      { error: 'Failed to update summary' },
      { status: 500 }
    );
  }
}