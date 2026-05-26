import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/services/database';
import { getSummaryModel } from '@/services/ai';
import { generateText } from 'ai';

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
    console.error('Error updating session status:', error);
    throw error;
  }
}

// Helper to format transcriptions for summary
function formatTranscriptionsForSummary(transcriptions: Array<{ text: string }>): string {
  return transcriptions
    .map(t => t.text)
    .join(' ');
}

// POST /api/summary/[sessionId] - Generate summary
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  // Auth gate runs before any DB / AI work so unauth callers can't burn
  // tokens or push the session into 'error' state.
  const userSession = await getServerSession(authOptions);
  if (!userSession?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Check if session exists
    const session = await db.getSessionById(sessionId);
    if (!session) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    // Get campaign information to include system prompt AND verify the
    // caller owns the campaign. Return 404 on ownership failure to avoid
    // leaking existence.
    const campaign = await db.getCampaignById(session.campaignId);
    if (!campaign || campaign.userId !== userSession.user.id) {
      return NextResponse.json(
        { error: 'Session not found' },
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

    console.log(`[Summary] Starting summary generation for session ${sessionId}`);
    await updateSessionStatus(sessionId, 'processing');

    // Format transcriptions for summarization
    const formattedText = formatTranscriptionsForSummary(transcriptions);

    // Build the prompt with optional campaign context.
    //
    // We split into `system` (rules the model must follow) and `prompt`
    // (the transcript to summarize). This gives the system rules more
    // weight than putting them inline with the transcript, and lets us
    // be explicit about what NOT to do — without those guardrails Gemini
    // in particular will happily ask the user follow-up questions
    // ("Could you please provide the names of your four adventurers?")
    // instead of just summarizing what's in the transcript.
    const systemRules = [
      'You are a D&D session chronicler. Your sole job is to produce a written summary of the transcript you are given.',
      '',
      'Hard rules — follow ALL of these:',
      '- Output ONLY the summary itself. No preamble, no greeting, no sign-off, no meta commentary.',
      '- Do NOT ask the user any questions. Do NOT request clarification or additional information.',
      '- Do NOT mention that information is missing, ambiguous, or that you "need" anything.',
      '- Use ONLY facts present in the transcript. Do not invent character names, places, items, or events.',
      '- If a character is unnamed in the transcript, refer to them by role, class, or description (e.g. "the rogue", "the fourth adventurer") instead of inventing a name or asking for one.',
      '- If the transcript is short or sparse, write a correspondingly short summary. A two-sentence summary of a two-sentence transcript is correct.',
      '',
      'Summary should cover (only when present in the transcript):',
      '- The story arc of the session — what happened, in order.',
      '- Key events, decisions, and character moments.',
      '- Which characters were involved in important scenes.',
      '- Combat highlights and character development.',
      '- The narrative tone and feel of the session.',
    ].join('\n');

    const systemPromptCombined = campaign.systemPrompt
      ? `${systemRules}\n\nAdditional campaign context (use as background; it does not override the rules above):\n${campaign.systemPrompt}`
      : systemRules;

    // Generate summary with Vercel AI SDK (provider chosen via AI_SUMMARY_PROVIDER env var)
    const { text: summaryText } = await generateText({
      model: getSummaryModel(),
      system: systemPromptCombined,
      prompt: `Transcript:\n\n${formattedText}\n\nWrite the summary now.`,
    });

    // Save summary to database
    await db.saveSummary(sessionId, summaryText);
    await updateSessionStatus(sessionId, 'completed');
    
    console.log(`[Summary] Summary generation completed for session ${sessionId}`);

    return NextResponse.json({
      message: 'Summary generated successfully',
      summary: summaryText
    });

  } catch (error) {
    console.error('[Summary Error]:', error);
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

  const userSession = await getServerSession(authOptions);
  if (!userSession?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Verify the session exists AND the caller owns its campaign before
  // returning summary text.
  const gamingSession = await db.getSessionById(sessionId);
  if (!gamingSession) {
    return NextResponse.json({ error: 'Summary not found' }, { status: 404 });
  }
  const campaign = await db.getCampaignById(gamingSession.campaignId);
  if (!campaign || campaign.userId !== userSession.user.id) {
    return NextResponse.json({ error: 'Summary not found' }, { status: 404 });
  }

  try {
    const summary = await db.getSummary(sessionId);

    if (!summary) {
      return NextResponse.json(
        { error: 'Summary not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(summary);
  } catch (error) {
    console.error('Error fetching summary:', error);
    
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
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }
    
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
    if (!campaign || campaign.userId !== session.user.id) {
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
    
    console.log(`[Summary] Summary updated for session ${sessionId}`);
    
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
    
    console.error('Error updating summary:', error);
    
    return NextResponse.json(
      { error: 'Failed to update summary' },
      { status: 500 }
    );
  }
}