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

You need Docker and an API key from [Soniox](https://soniox.com), [ElevenLabs](https://elevenlabs.io), or [AssemblyAI](https://www.assemblyai.com).

```sh
mkdir voices && cd voices
curl -fsSLO https://raw.githubusercontent.com/CorrectRoadH/Voices/main/deploy/compose.yaml
docker compose up -d
```

Open <http://localhost:8080> and follow the prompts:

1. Sign up. The first account becomes the administrator.
2. Set up a model for AI summaries, or skip this step.
3. Enter your transcription API key under Server management, then start dropping in recordings.

To use ElevenLabs, save the API key and restart the app (`docker compose restart app` with Docker Compose). Select **ElevenLabs → Scribe v2** in transcription preferences. Importing or retranscribing a recording with this provider sends its audio to ElevenLabs.

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

The Go application includes the voiceprint engine and model: identify a person to build samples for future recordings. Direct execution and `air .` need no additional service or configuration.

All data lives in the `postgres_data` volume. [Back up the database](docs/operations.md#备份与恢复) before upgrading.

#### Upgrade to PostgreSQL 19

Keep the previous Compose file. From the original deployment directory and with the same project name, run `docker compose stop app db`. Replace the Compose file and run `docker compose up -d`. A one-time service upgrades the `18/docker` cluster to `19/docker` in the same volume. The database and app start afterward. Fresh and already upgraded installations skip the migration.

The migration requires free disk space of at least 1.2 times the size of the old cluster. It also needs access to the PostgreSQL APT repository to download PostgreSQL 18. If the upgrade fails, run `docker compose logs postgres-upgrade`. Fix the reported error and run `docker compose up -d` again.

To roll back, run `docker compose stop app db`, restore the previous Compose file, and run `docker compose up -d`. The old cluster contains data from before the upgrade. If automatic upgrade keeps failing, start the database with the old configuration and migrate it manually.

1. Keep the app stopped and export the old database.

   ```sh
   umask 077
   docker compose exec -T db pg_dump -U voices -d voices -Fc > voices-pg18.dump &&
     docker compose stop db
   ```

2. Switch to the new Compose file. Initialize PG19 in a temporary directory on the same volume.

   ```sh
   restore_container=$(docker compose run -d --no-deps \
     -e PGDATA=/var/lib/postgresql/19/manual-restore db)
   ```

3. In the same shell, run `docker exec "$restore_container" pg_isready -h 127.0.0.1 -U voices -d voices`. Once PG19 accepts connections, load the backup and start the full application.

   ```sh
   docker exec -i "$restore_container" pg_restore -U voices -d voices --single-transaction < voices-pg18.dump &&
     docker stop "$restore_container" &&
     docker rm "$restore_container" &&
     docker compose run --rm --no-deps --entrypoint sh db -ec '
       if [ -d "$PGDATA" ]; then rmdir "$PGDATA"; fi
       mv -T /var/lib/postgresql/19/manual-restore "$PGDATA"
     ' &&
     docker compose up -d
   ```

Verify the application data and back up PG19 before deleting the old cluster to free disk space. Deleting the old cluster removes the ability to roll back to it.

```sh
docker compose exec -T db psql -U voices -d voices -Atc 'SHOW data_directory'
# Run the next command after confirming the output is /var/lib/postgresql/19/docker.
docker compose exec -T -u root db rm -rf -- /var/lib/postgresql/18/docker
```

## Acknowledgments

We thank [Linux Do](https://linux.do) for their support and feedback during the project's early development.
