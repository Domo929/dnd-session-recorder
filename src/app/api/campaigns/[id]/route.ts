import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/services/database';
import { requireCampaignAccess } from '@/lib/permissions';

const updateCampaignSchema = z.object({
  name: z.string().min(1, 'Campaign name is required'),
  description: z.string().optional(),
  systemPrompt: z.string().optional(),
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
    });

    return NextResponse.json(updatedCampaign);
  } catch (error) {
    console.error('Error updating campaign:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation error', details: error.issues },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to update campaign' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const access = await requireCampaignAccess(id, 'owner');
    if (!access.ok) return access.response;

    await db.deleteCampaign(id);

    return NextResponse.json({ message: 'Campaign deleted successfully' });
  } catch (error) {
    console.error('Error deleting campaign:', error);

    return NextResponse.json(
      { error: 'Failed to delete campaign' },
      { status: 500 }
    );
  }
}

export async function GET(
  _request: NextRequest,
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

    // Players don't see the DM's systemPrompt (it may contain spoilers/notes).
    const payload =
      access.role === 'owner'
        ? { ...campaign, role: access.role }
        : { ...campaign, systemPrompt: null, role: access.role };

    return NextResponse.json(payload);
  } catch (error) {
    console.error('Error fetching campaign:', error);

    return NextResponse.json(
      { error: 'Failed to fetch campaign' },
      { status: 500 }
    );
  }
}
