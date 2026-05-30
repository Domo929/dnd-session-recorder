import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/services/database';
import { requireSessionAccess } from '@/lib/permissions';
import { logger } from '@/lib/logger';

const updateSessionStatusSchema = z.object({
  status: z.enum(['pending', 'processing', 'completed', 'error']),
});

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionId = (await params).id;
    
    if (!sessionId) {
      return NextResponse.json(
        { error: 'Invalid session ID' },
        { status: 400 }
      );
    }

    // Any member of the session's campaign may read it.
    const access = await requireSessionAccess(sessionId, 'any');
    if (!access.ok) return access.response;

    const session = await db.getSessionById(sessionId);
    
    if (!session) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }
    
    // Transform data to match existing API format
    const transformedSession = {
      ...session,
      campaign_name: session.campaign.name,
    };
    
    return NextResponse.json(transformedSession);
  } catch (error) {
    logger.error('Failed to fetch session', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch session' },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionId = (await params).id;
    
    if (!sessionId) {
      return NextResponse.json(
        { error: 'Invalid session ID' },
        { status: 400 }
      );
    }

    // Only the campaign owner may change a session's status.
    const access = await requireSessionAccess(sessionId, 'owner');
    if (!access.ok) return access.response;

    const body = await request.json();
    const validatedData = updateSessionStatusSchema.parse(body);
    
    const session = await db.updateSessionStatus(sessionId, validatedData.status);
    
    return NextResponse.json({ message: 'Session status updated successfully', session });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation error', details: error.issues },
        { status: 400 }
      );
    }

    logger.error('Failed to update session status', error as Error);
    return NextResponse.json(
      { error: 'Failed to update session status' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionId = (await params).id;

    if (!sessionId) {
      return NextResponse.json(
        { error: 'Invalid session ID' },
        { status: 400 }
      );
    }

    // Only the campaign owner may delete a session.
    const access = await requireSessionAccess(sessionId, 'owner');
    if (!access.ok) return access.response;

    // Get session to return campaign ID for redirect
    const session = await db.getSessionById(sessionId);
    if (!session) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    const campaignId = session.campaignId;

    await db.deleteSession(sessionId);

    return NextResponse.json({
      message: 'Session deleted successfully',
      campaignId
    });
  } catch (error) {
    logger.error('Failed to delete session', error as Error);
    return NextResponse.json(
      { error: 'Failed to delete session' },
      { status: 500 }
    );
  }
}