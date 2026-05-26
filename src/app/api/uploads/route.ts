import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { promisify } from 'util';
import { exec } from 'child_process';
import ffprobeStatic from 'ffprobe-static';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/services/database';

const uploadDir = process.env.UPLOAD_DIR || './uploads';
const maxFileSize = parseInt(process.env.MAX_FILE_SIZE || '100000000'); // 100MB default

const allowedMimeTypes = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/ogg',
  'audio/m4a',
  'audio/mp4',
  'audio/aac',
  'audio/flac',
  'audio/webm',
];

async function ensureUploadDir() {
  if (!existsSync(uploadDir)) {
    await mkdir(uploadDir, { recursive: true });
  }
}

async function getAudioDuration(filePath: string): Promise<number | null> {
  try {
    const execAsync = promisify(exec);
    // In production we rely on the system-installed ffprobe (provided by the
    // `ffmpeg` apk package in the Dockerfile). The `ffprobe-static` binary is
    // not traced into the Next.js standalone output, so falling through to it
    // in production silently fails and leaves duration as null. Keep it as a
    // fallback for local dev where ffmpeg may not be installed system-wide.
    const ffprobeBin =
      process.env.NODE_ENV === 'production'
        ? 'ffprobe'
        : (ffprobeStatic.path as string);
    const command = `${ffprobeBin} -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`;
    const { stdout } = await execAsync(command);
    const duration = parseFloat(stdout.trim());
    return isNaN(duration) ? null : Math.round(duration);
  } catch (error) {
    console.error('Error getting audio duration:', error);
    return null;
  }
}

// GET /api/uploads - list uploads owned by the signed-in user
export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const uploads = await db.getUploads(session.user.id);
    return NextResponse.json({ uploads });
  } catch (error) {
    console.error('Error listing uploads:', error);
    return NextResponse.json({ error: 'Failed to list uploads' }, { status: 500 });
  }
}

// POST /api/uploads - upload an audio file and persist an Upload row for the signed-in user
export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await ensureUploadDir();

    const formData = await request.formData();
    const file = formData.get('audio') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No audio file provided' }, { status: 400 });
    }

    if (!allowedMimeTypes.includes(file.type)) {
      return NextResponse.json(
        { error: 'Invalid file type. Only audio files are allowed.' },
        { status: 400 }
      );
    }

    if (file.size > maxFileSize) {
      return NextResponse.json({ error: 'File too large' }, { status: 400 });
    }

    const extension = path.extname(file.name);
    const uniqueName = `${Date.now()}-${uuidv4()}${extension}`;
    const filePath = path.join(uploadDir, uniqueName);

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    await writeFile(filePath, buffer);

    const duration = await getAudioDuration(filePath);

    const upload = await db.createUpload({
      userId: session.user.id,
      filename: uniqueName,
      originalName: file.name,
      path: filePath,
      size: file.size,
      mimetype: file.type,
      duration: duration ?? undefined,
    });

    console.log(`[Upload] File uploaded successfully: ${uniqueName} (id=${upload.id})`);

    return NextResponse.json({
      message: 'File uploaded successfully',
      upload,
    });
  } catch (error) {
    console.error('Upload error:', error);
    return NextResponse.json({ error: 'Failed to upload file' }, { status: 500 });
  }
}
