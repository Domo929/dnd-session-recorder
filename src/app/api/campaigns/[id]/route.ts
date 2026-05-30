import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/services/database';
import { requireCampaignAccess } from '@/lib/permissions';
import { logger } from '@/lib/logger';

const updateCampaignSchema = z.object({
  name: z.string().min(1, 'Campaign name is required'),
  description: z.string().optional(),
  systemPrompt: z.string().optional(),
  transcriptionVocabulary: z.string().optional(),
});

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const access = await requireCampaignAccess(id, 'owner');
    if (!access.ok) return access.response;

    const body = await request.json();
    const validatedData = updateCampaignSchema.parse(body);

    const updatedCampaign = await db.updateCampaign(id, {
      name: validatedData.name,
      description: validatedData.description,
      systemPrompt: validatedData.systemPrompt,
      transcriptionVocabulary: validatedData.transcriptionVocabulary,
    });

    return NextResponse.json(updatedCampaign);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation error', details: error.issues },
        { status: 400 }
      );
    }

    logger.error('Failed to update campaign', error as Error);

    return NextResponse.json(
      { error: 'Failed to update campaign' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const access = await requireCampaignAccess(id, 'owner');
    if (!access.ok) return access.response;

    await db.deleteCampaign(id);

    return NextResponse.json({ message: 'Campaign deleted successfully' });
  } catch (error) {
    logger.error('Failed to delete campaign', error as Error);

    return NextResponse.json(
      { error: 'Failed to delete campaign' },
      { status: 500 }
    );
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const access = await requireCampaignAccess(id, 'any');
    if (!access.ok) return access.response;

    const campaign = await db.getCampaignById(id);
    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
    }

    return NextResponse.json({ ...campaign, viewerRole: access.role });
  } catch (error) {
    logger.error('Failed to fetch campaign', error as Error);

    return NextResponse.json(
      { error: 'Failed to fetch campaign' },
      { status: 500 }
    );
  }
}
