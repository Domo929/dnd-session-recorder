import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/services/database';
import { requireCampaignAccess } from '@/lib/permissions';

const linkUploadSchema = z.object({
  upload_id: z.string().min(1, 'Upload ID is required'),
});

const FROZEN_STATUSES = new Set(['transcribing', 'transcribed', 'summarizing', 'completed']);

async function resolveSession(sessionId: string) {
  const gamingSession = await db.getSessionById(sessionId);
  if (!gamingSession) {
    return {
      error: NextResponse.json({ error: 'Session not found' }, { status: 404 }),
    };
  }
  const access = await requireCampaignAccess(gamingSession.campaignId, 'owner');
  if (!access.ok) return { error: access.response };
  return { gamingSession, access };
}

// POST /api/sessions/[id]/upload - Link upload to session
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionId = (await params).id;
    const resolved = await resolveSession(sessionId);
    if ('error' in resolved) return resolved.error;
    const { gamingSession, access } = resolved;

    const body = await request.json();
    const validatedData = linkUploadSchema.parse(body);

    if (FROZEN_STATUSES.has(gamingSession.status)) {
      return NextResponse.json(
        { error: 'Cannot change upload after transcription has started' },
        { status: 400 }
      );
    }

    const upload = await db.getUploadById(validatedData.upload_id);
    if (!upload || upload.userId !== access.userId) {
      return NextResponse.json({ error: 'Upload not found' }, { status: 404 });
    }

    const updatedSession = await db.linkSessionToUpload(sessionId, validatedData.upload_id);

    return NextResponse.json({
      message: 'Upload linked to session successfully',
      session: updatedSession
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation error', details: error.issues },
        { status: 400 }
      );
    }

    console.error('Error linking upload to session:', error);
    return NextResponse.json(
      { error: 'Failed to link upload to session' },
      { status: 500 }
    );
  }
}

// PUT /api/sessions/[id]/upload - Replace session's upload
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionId = (await params).id;
    const resolved = await resolveSession(sessionId);
    if ('error' in resolved) return resolved.error;
    const { gamingSession, access } = resolved;

    const body = await request.json();
    const validatedData = linkUploadSchema.parse(body);

    if (FROZEN_STATUSES.has(gamingSession.status)) {
      return NextResponse.json(
        { error: 'Cannot change upload after transcription has started' },
        { status: 400 }
      );
    }

    const upload = await db.getUploadById(validatedData.upload_id);
    if (!upload || upload.userId !== access.userId) {
      return NextResponse.json({ error: 'Upload not found' }, { status: 404 });
    }

    const updatedSession = await db.linkSessionToUpload(sessionId, validatedData.upload_id);

    return NextResponse.json({
      message: 'Upload replaced successfully',
      session: updatedSession
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation error', details: error.issues },
        { status: 400 }
      );
    }

    console.error('Error replacing upload:', error);
    return NextResponse.json(
      { error: 'Failed to replace upload' },
      { status: 500 }
    );
  }
}

// DELETE /api/sessions/[id]/upload - Unlink upload from session
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionId = (await params).id;
    const resolved = await resolveSession(sessionId);
    if ('error' in resolved) return resolved.error;
    const { gamingSession } = resolved;

    if (FROZEN_STATUSES.has(gamingSession.status)) {
      return NextResponse.json(
        { error: 'Cannot remove upload after transcription has started' },
        { status: 400 }
      );
    }

    const updatedSession = await db.unlinkSessionFromUpload(sessionId);

    return NextResponse.json({
      message: 'Upload unlinked from session successfully',
      session: updatedSession
    });

  } catch (error) {
    console.error('Error unlinking upload from session:', error);
    return NextResponse.json(
      { error: 'Failed to unlink upload from session' },
      { status: 500 }
    );
  }
}
