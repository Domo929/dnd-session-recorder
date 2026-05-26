# D&D Session Recorder

An AI-powered web application for recording, transcribing, and summarizing Dungeons & Dragons sessions. Built with Next.js, this application helps Dungeon Masters manage their campaigns with automatic transcription and intelligent summaries.

## Features

### Current Capabilities

- **🎙️ Audio Recording & Upload**: Support for various audio formats with automatic processing
- **🤖 AI Transcription**: Pluggable — choose OpenAI Whisper (default), Google Gemini, or fully-local whisper.cpp
- **📋 Intelligent Summaries**: Pluggable — choose OpenAI GPT-4o (default) or Google Gemini
- **👥 User Authentication**: Secure login with Google OAuth and local credentials
- **📚 Campaign Management**: Create, organize, and manage multiple D&D campaigns
- **🎮 Session Organization**: Track sessions by campaign with date and duration
- **🔍 Transcript Search**: Full-text search within session transcripts
- **📊 Session Analytics**: View session statistics and completion status
- **📱 Responsive Design**: Works seamlessly on desktop and mobile devices
- **💾 Export Options**: Download transcripts and summaries in various formats

## Technology Stack

- **Frontend**: Next.js 15 with React 19, TypeScript, Tailwind CSS
- **Backend**: Next.js API Routes with serverless functions
- **Database**: PostgreSQL with Prisma ORM (SQLite supported on the upstream branch only)
- **Authentication**: NextAuth.js with Google OAuth and local credentials
- **AI Services**: Pluggable provider layer — OpenAI (Whisper + GPT-4o), Google Gemini, and/or local whisper.cpp via `nodejs-whisper`
- **File Processing**: FFmpeg for audio processing and metadata extraction
- **UI Components**: Lucide React icons, custom Tailwind components
- **State Management**: TanStack Query for server state management

## Database Schema

The application uses a well-structured database with the following key entities:

### User Management
- **Users**: Stores user authentication data, profiles, and OAuth information
- **Accounts**: OAuth account linking (Google, etc.)
- **Sessions**: Authentication sessions and tokens
- **VerificationTokens**: Email verification and password reset tokens

### Campaign Structure
- **Campaigns**: D&D campaigns with descriptions and user ownership
- **GamingSessions**: Individual game sessions linked to campaigns
- **Transcriptions**: Timestamped transcript segments with confidence scores
- **Summaries**: AI-generated session summaries with key events

### Relationships
- Users can have multiple Campaigns
- Campaigns contain multiple GamingSessions
- GamingSessions have multiple Transcriptions and one Summary
- All data is properly scoped to authenticated users

## Getting Started

### Prerequisites

- Node.js 18+ and npm
- `ffmpeg` on `PATH` (required for audio chunking and for the local whisper provider)
- An API key for whichever cloud AI provider you choose:
  - **OpenAI** (default): `OPENAI_API_KEY`
  - **Google Gemini**: `GOOGLE_GENERATIVE_AI_API_KEY` (get one from [Google AI Studio](https://aistudio.google.com/apikey))
  - Neither is required if you use `whisper-local` for transcription **and** keep the summary disabled — but at least one summary provider key is needed to generate summaries.
- Google OAuth credentials (optional, for Google login)
- Build tools (`build-essential`/`make`, `cmake`, `git`, `python3`) — **only** if you want the optional local-whisper provider. Without them, `nodejs-whisper` skips compiling and the `whisper-local` option is unavailable, but everything else still installs cleanly.

### Installation

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd dnd-session-recorder
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Set up environment variables**:
   ```bash
   cp env.example .env.local
   ```
   
   Edit `.env.local` with your configuration (see Environment Variables section below).

4. **Start PostgreSQL** (required, replaces previous SQLite setup):
   ```bash
   # Easiest: use the bundled docker-compose service
   docker compose up -d postgres

   # Or run a standalone container:
   # docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=devpassword \
   #   -e POSTGRES_USER=dndrec -e POSTGRES_DB=dndrec --name dnd-postgres postgres:16-alpine
   ```

5. **Set up the database schema**:
   ```bash
   npx prisma migrate deploy
   npx prisma generate
   ```

6. **Run the development server**:
   ```bash
   npm run dev
   ```

7. **Open the application**:
   Visit [http://localhost:3000](http://localhost:3000) in your browser.

### Environment Variables

Create a `.env.local` file in the project root. See `env.example` for the full, commented list. Minimum to run with the default OpenAI setup:

```bash
# Database (PostgreSQL — see "Start PostgreSQL" step above)
DATABASE_URL="postgresql://dndrec:devpassword@localhost:5432/dndrec"

# OpenAI Configuration (default provider for transcription + summary)
OPENAI_API_KEY="your-openai-api-key"

# NextAuth Configuration (Required)
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="your-nextauth-secret"

# Google OAuth Configuration (Optional)
GOOGLE_CLIENT_ID="your-google-client-id"
GOOGLE_CLIENT_SECRET="your-google-client-secret"
NEXT_PUBLIC_GOOGLE_ENABLED="true"

# File Upload Configuration
UPLOAD_DIR="./uploads"
MAX_FILE_SIZE="100000000"
CORS_ORIGIN="http://localhost:3000"
```

### Choosing an AI provider

Transcription and summarization are independently configurable. The defaults preserve the original OpenAI behavior — existing deployments need no changes.

| Step | Env var | Allowed values | Default | Extra requirements |
|---|---|---|---|---|
| Transcription | `AI_TRANSCRIPTION_PROVIDER` | `openai`, `google`, `whisper-local` | `openai` | See per-provider notes below |
| Summary | `AI_SUMMARY_PROVIDER` | `openai`, `google` | `openai` | API key for the chosen provider |

Per-provider configuration:

**OpenAI** (`openai`) — uses Whisper for transcription, GPT-4o for summaries.
- Requires `OPENAI_API_KEY`.
- Optional: `OPENAI_TRANSCRIPTION_MODEL` (default `whisper-1`), `OPENAI_SUMMARY_MODEL` (default `gpt-4o`).

**Google Gemini** (`google`) — uses `gemini-2.5-flash` for both transcription and summaries.
- Requires `GOOGLE_GENERATIVE_AI_API_KEY`.
- Optional: `GOOGLE_TRANSCRIPTION_MODEL`, `GOOGLE_SUMMARY_MODEL`.
- Gemini accepts audio as multimodal input; files over ~18 MB are automatically split with ffmpeg into inline-sized chunks. (For very long sessions you may want to use `whisper-local` instead, which handles arbitrary length natively.)

**Local whisper.cpp** (`whisper-local`, transcription only) — runs entirely on your machine, no API key, no data leaves the host.
- Requires the optional `nodejs-whisper` package to have built successfully (`build-essential`, `cmake` >= 3.18, `git`, `python3` on Linux; Xcode CLT on macOS).
- One-time setup: `npx nodejs-whisper download` — compiles whisper.cpp (~1–3 min on CPU, longer with CUDA) and prompts you to pick a model. Files land in `node_modules/nodejs-whisper/cpp/whisper.cpp/models/`.
- Optional: `WHISPER_MODEL` (default `base.en`; other choices include `tiny.en`, `small.en`, `medium.en`, `large-v3`, `large-v3-turbo`), `WHISPER_MODELS_DIR` (override the model location — unset means use nodejs-whisper's bundled default), `WHISPER_USE_CUDA=true` if you have a CUDA GPU and the CUDA Toolkit installed.

Example combinations:

```bash
# Cheapest cloud setup: Gemini for everything
AI_TRANSCRIPTION_PROVIDER=google
AI_SUMMARY_PROVIDER=google
GOOGLE_GENERATIVE_AI_API_KEY=...

# Fully local transcription + cloud summary
AI_TRANSCRIPTION_PROVIDER=whisper-local
WHISPER_MODEL=base.en
AI_SUMMARY_PROVIDER=google
GOOGLE_GENERATIVE_AI_API_KEY=...

# Original behavior (no .env changes needed)
# AI_TRANSCRIPTION_PROVIDER=openai
# AI_SUMMARY_PROVIDER=openai
OPENAI_API_KEY=...
```

### Production Deployment

1. **Build the application**:
   ```bash
   npm run build
   ```

2. **Start the production server**:
   ```bash
   npm start
   ```

3. **Update environment variables** for production:
   - Change `NEXTAUTH_URL` to your production domain
   - Use a secure `NEXTAUTH_SECRET`
   - Configure production database URL
   - Set up proper CORS origins

## Usage

1. **Sign up** or log in to your account
2. **Create a campaign** to organize your sessions
3. **Upload audio** from your D&D session
4. **Wait for processing** (transcription and summarization)
5. **Review transcripts** and summaries
6. **Export or share** your session documentation

## Future Enhancements

### 1. Campaign-Specific Transcription Prompts
- Custom prompts for better transcription accuracy
- Campaign-specific terminology and character names
- Context-aware transcription improvements
- Custom vocabulary for fantasy terms and names

### 2. Character and Player Management System
- Character profile creation with stats and backstories
- Player assignment and character progression tracking
- Character relationship mapping and development arcs
- Integration with transcription for character moment extraction

### 3. Advanced Session Analytics and Insights
- Speaking time analysis per player/character
- Combat vs. roleplay time breakdown
- Emotional tone analysis and player engagement metrics
- Session pacing analysis and improvement suggestions

### 4. Real-time Collaboration and Note-taking
- Live collaborative note-taking during sessions
- Real-time session bookmarking and annotations
- Mobile app for player contributions
- Integration with popular VTT platforms (Roll20, Foundry VTT)

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

For support and questions, please open an issue in the GitHub repository.