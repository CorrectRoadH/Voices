# Voices

[中文](README.md) · English

For people who record their day. Drop in audio from your recorder or phone, and Voices transcribes it and sorts out who's speaking. Search for what someone said and when, then click to hear it again. Everything stays on your own server.

## Features

- Automatic transcription with speaker separation
- Edit and organize transcripts in the browser
- Quote sentences with links back to the audio
- AI summaries (optional)
- Multiple users

## Quick start

You need Docker and an API key from [Soniox](https://soniox.com) or [AssemblyAI](https://www.assemblyai.com).

```sh
mkdir voices && cd voices
curl -fsSLO https://raw.githubusercontent.com/CorrectRoadH/Voices/main/deploy/compose.yaml
docker compose up -d
```

Open <http://localhost:8080> and follow the prompts:

1. Sign up. The first account becomes the administrator.
2. Set up a model for AI summaries, or skip this step.
3. Enter your transcription API key under Server management, then start dropping in recordings.

### Access from your phone or another computer

Voices listens on port 8080 on your local network. To use it through this machine's IP, include the address the first time you start it:

```sh
PUBLIC_BASE_URL=http://192.168.1.10:8080 docker compose up -d
```

Replace `192.168.1.10` with the IP of the machine running Voices. The address is saved, so later starts don't need it. If you've already started Voices, change the site address under Server management → Server settings, then run `docker compose restart`. Without this address, other devices can load the page but can't sign in.

Create the administrator account right after startup so no one else on the network signs up first. For public access, put an HTTPS reverse proxy in front. See the [deployment guide](docs/operations.md) (in Chinese).

### Upgrade

```sh
docker compose pull && docker compose up -d
```

All data lives in the `postgres_data` volume. Back it up before upgrading. See [backup and restore](docs/operations.md).

## Acknowledgments

We thank [Linux Do](https://linux.do) for their support and feedback during the project's early development.
