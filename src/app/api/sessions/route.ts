import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/services/database';
import { requireCampaignAccess } from '@/lib/permissions';

const createSessionSchema = z.object({
  campaign_id: z.string('Campaign ID must be a positive integer'),
  title: z.string().min(1, 'Session title is required'),
  session_date: z.string('Invalid session date format'),
  upload_id: z.string().optional(),
  audio_file_path: z.string().optional(),
  duration: z.number().int().positive().nullish(),
  status: z.string().optional(),
});

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    
    if (!session?.user?.id) {
      return NextResponse.json([]);
    }

    const { searchParams } = new URL(request.url);
    const campaignId = searchParams.get('campaignId');
    
    const sessions = await db.getSessions(session.user.id, campaignId || undefined);
    
    // Transform data to match existing API format
    const transformedSessions = await Promise.all(sessions.map(async session => ({
      ...session,
      campaign_name: session.campaign.name,
      total_speech_time: session._count.transcriptions > 0 ? 
        await db.getTotalSpeechTime(session.id) : 0,
    })));
    
    return NextResponse.json(transformedSessions);
  } catch (error) {
    console.error('Error fetching sessions:', error);
    return NextResponse.json(
      { error: 'Failed to fetch sessions' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const validatedData = createSessionSchema.parse(body);

    // Verify campaign membership AND require owner role to create sessions.
    const access = await requireCampaignAccess(validatedData.campaign_id, 'owner');
    if (!access.ok) return access.response;

    // If upload_id is provided, verify it exists and belongs to this user
    // (uploads remain per-user, independent of campaign membership).
    if (validatedData.upload_id) {
      const upload = await db.getUploadById(validatedData.upload_id);
      if (!upload || upload.userId !== access.userId) {
        return NextResponse.json(
          { error: 'Upload not found' },
          { status: 404 }
        );
      }
    }

    const gamingSession = await db.createSession({
      campaignId: validatedData.campaign_id,
      title: validatedData.title,
      sessionDate: new Date(validatedData.session_date),
      uploadId: validatedData.upload_id,
      audioFilePath: validatedData.audio_file_path,
      duration: validatedData.duration ?? undefined,
      status: validatedData.status,
    });

    return NextResponse.json(gamingSession, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation error', details: error.issues },
        { status: 400 }
      );
    }

    console.error('Error creating session:', error);
    return NextResponse.json(
      { error: 'Failed to create session' },
      { status: 500 }
    );
  }
}