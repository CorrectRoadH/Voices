# Voices

[中文](README.md) · English

**Turn everyday recordings into conversations you can read, search and quote.**

Voices is a self-hosted recording workbench. Drop in meetings, interviews or voice notes and it transcribes them with speaker separation, showing every sentence as a chat message. Fix words as you read, mark who said what, and copy any sentence as a linked quote that jumps back to the original audio.

Your recordings and transcripts stay on your own server.

## Why Voices

- **Just drop files in**: drag several files at once and transcription starts as soon as they upload. Duplicates are detected and kept only once.
- **Read recordings like a chat**: your lines on the right, everyone else on the left, with names and avatars. Tap a sentence to play just that sentence, tap the text to edit it.
- **Know who's talking**: link "Speaker 1" to a person profile and follow that person across recordings, or filter your library by person. Background noise, music and system prompts can be tagged and hidden.
- **Every sentence is a link**: paste `[Alex: Let's review the plan tomorrow morning](link)` into your notes. Opening it lands on that exact sentence and audio position, even after you edit text or re-transcribe.
- **Corrections are never overwritten**: re-transcribing creates a new version. Older versions and your edits are kept, and you choose which one is active.
- **Export anytime**: TXT, JSON or SRT subtitles.
- **Multilingual**: auto-detect, single language, or mixed-language modes, powered by [Soniox](https://soniox.com) and [AssemblyAI](https://www.assemblyai.com).
- **Share with family or a small team**: every account's data is fully separate. Even the admin can't see other users' recordings.

## Your data, your server

- Audio, transcripts and people all live in your own PostgreSQL, so backing up one database covers everything.
- Provider API keys stay on the server and never reach the browser.
- After a network failure, requests the provider may already have received are never resent automatically, so you aren't charged twice.
- The app itself is stateless, so containers can be rebuilt or scaled out at any time.

## Quick start

You need Docker. Create `.env` in the project root:

```sh
POSTGRES_PASSWORD=<random hex string>
# Optional; you can also set it later in the web UI
SONIOX_API_KEY=
```

```sh
docker compose up --build -d
```

Open <http://localhost:8080>. The first account to register becomes the admin and can configure transcription providers, close registration and manage accounts under Server management.

For public access, put an HTTPS reverse proxy in front and set `PUBLIC_BASE_URL` in `.env` to the real address before the first start; change it later in Server settings.

## Learn more

- [Deployment, configuration, backup and restore](docs/operations.md)
- [Local development and testing](docs/development.md)
- [Product and architecture docs](docs/README.md)

The docs are written in Chinese. The frontend is built with React and shadcn/ui; the backend with Go and PostgreSQL.
