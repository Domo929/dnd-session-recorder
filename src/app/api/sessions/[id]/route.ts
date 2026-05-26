import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/services/database';
import { requireCampaignAccess } from '@/lib/permissions';

// NOTE: there are more session statuses in use than the four listed here
// (e.g. 'transcribing', 'transcribed', 'summarizing', 'uploaded'). This
// schema is conservative on purpose — the PATCH route is currently only
// used by the UI for a small set of transitions. Extending it is tracked
// separately from this auth audit.
const updateSessionStatusSchema = z.object({
  status: z.enum(['pending', 'processing', 'completed', 'error']),
});

// Resolve a session + assert campaign membership at the requested level.
// Returns either a NextResponse (caller should return it directly) or the
// session plus the access info from requireCampaignAccess.
async function resolveSessionAccess(
  sessionId: string,
  level: 'any' | 'owner',
) {
  const session = await db.getSessionById(sessionId);
  if (!session) {
    return {
      error: NextResponse.json({ error: 'Session not found' }, { status: 404 }),
    };
  }
  const access = await requireCampaignAccess(session.campaignId, level);
  if (!access.ok) return { error: access.response };
  return { session, role: access.role, userId: access.userId };
}

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

    const resolved = await resolveSessionAccess(sessionId, 'any');
    if ('error' in resolved) return resolved.error;

    // Transform data to match existing API format
    const transformedSession = {
      ...resolved.session,
      campaign_name: resolved.session.campaign.name,
    };

    return NextResponse.json(transformedSession);
  } catch (error) {
    console.error('Error fetching session:', error);
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

    const resolved = await resolveSessionAccess(sessionId, 'owner');
    if ('error' in resolved) return resolved.error;

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

    console.error('Error updating session status:', error);
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

    const resolved = await resolveSessionAccess(sessionId, 'owner');
    if ('error' in resolved) return resolved.error;

    await db.deleteSession(sessionId);

    return NextResponse.json({ message: 'Session deleted successfully' });
  } catch (error) {
    console.error('Error deleting session:', error);
    return NextResponse.json(
      { error: 'Failed to delete session' },
      { status: 500 }
    );
  }
}
