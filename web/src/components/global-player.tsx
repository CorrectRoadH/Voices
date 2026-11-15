// @concord-file
// @concord-implements docs/feature/transcription/use-case/read-transcript.md#global-playback
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useSegmentPlayback } from "@/lib/use-segment-playback";
import { apiUrl } from "@/lib/api";
import { notify } from "@/lib/notify";
import { tr } from "@/lib/i18n";
import type { Recording, Segment } from "@/lib/types";

type PlaybackSource = { id: string; title: string; transcriptionId?: string };
function usePlaybackController() {
  const controller = useSegmentPlayback("session", (message) => notify(message, true));
  const { audioRef, pause, seek, resetFailure } = controller;
  const [source, setSource] = useState<PlaybackSource | null>(null);
  const sourceRef = useRef<PlaybackSource | null>(null);
  const dismissed = useRef<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [outlineSlot, setOutlineSlot] = useState<HTMLDivElement | null>(null);
  const select = useCallback(
    (next: PlaybackSource) => {
      dismissed.current = null;
      const previous = sourceRef.current;
      if (previous?.id !== next.id) {
        pause();
        resetFailure();
        sourceRef.current = next;
        if (audioRef.current) {
          audioRef.current.src = apiUrl(`/recordings/${encodeURIComponent(next.id)}/audio`);
          audioRef.current.load();
        }
      } else {
        sourceRef.current = next;
      }
      if (
        previous?.id !== next.id ||
        previous.title !== next.title ||
        previous.transcriptionId !== next.transcriptionId
      )
        setSource(next);
    },
    [audioRef, pause, resetFailure],
  );
  const prepare = useCallback(
    (next: PlaybackSource) => {
      if (!sourceRef.current && dismissed.current !== next.id) select(next);
      else if (sourceRef.current?.id === next.id && sourceRef.current.title !== next.title)
        select({ ...sourceRef.current, title: next.title });
    },
    [select],
  );
  const close = useCallback(
    (id?: string) => {
      if (id && sourceRef.current?.id !== id) return;
      pause();
      dismissed.current = sourceRef.current?.id ?? dismissed.current;
      sourceRef.current = null;
      setSource(null);
      resetFailure();
      const audio = audioRef.current;
      if (audio) {
        audio.removeAttribute("src");
        audio.load();
      }
    },
    [audioRef, pause, resetFailure],
  );
  const pauseSource = useCallback(
    (id: string) => {
      if (sourceRef.current?.id === id) pause();
    },
    [pause],
  );
  const seekSource = useCallback(
    (id: string, time: number) => {
      if (sourceRef.current?.id === id && audioRef.current?.paused) seek(time);
    },
    [audioRef, seek],
  );
  return {
    ...controller,
    source,
    sourceRef,
    panelRef,
    outlineSlot,
    setOutlineSlot,
    select,
    prepare,
    close,
    pauseSource,
    seekSource,
  };
}

const PlaybackContext = createContext<ReturnType<typeof usePlaybackController> | null>(null);
export function GlobalPlaybackProvider({ children }: { children: ReactNode }) {
  const playback = usePlaybackController();
  return <PlaybackContext value={playback}>{children}</PlaybackContext>;
}
export function useGlobalPlayback() {
  const playback = useContext(PlaybackContext);
  if (!playback) throw new Error("GlobalPlaybackProvider is required");
  return playback;
}

export function useRecordingPlayback(recording: Recording | null, transcriptionId?: string) {
  const global = useGlobalPlayback();
  const { prepare, close, pauseSource, seekSource } = global;
  const id = recording?.id ?? "";
  const title = recording?.title || recording?.original_name || "";
  const ready = recording?.state === "ready";
  // Deliberately independent of global source changes: closing must not reopen the player.
  useEffect(() => {
    if (ready) prepare({ id, title, transcriptionId });
    else if (id) close(id);
  }, [id, title, ready, transcriptionId, prepare, close]);
  const pending = useRef<{ id: string; time: number } | null>(null);
  const queueSeek = useCallback(
    (time: number | null) => {
      pending.current = time === null ? null : { id, time };
    },
    [id],
  );
  const flushSeek = useCallback(() => {
    const target = pending.current;
    pending.current = null;
    if (target?.id === id) seekSource(id, target.time);
  }, [id, seekSource]);
  const source = { id, title, transcriptionId };
  return {
    ...global,
    active: global.source?.id === id,
    queueSeek,
    flushSeek,
    pause: () => pauseSource(id),
    seek: (time: number) => seekSource(id, time),
    play: async (segment: Segment) => {
      if (!ready) return;
      global.select(source);
      await global.play(segment);
    },
    playRecording: async () => {
      if (!ready) return;
      global.select(source);
      await global.playAll();
    },
  };
}

export function GlobalPlayer() {
  const playback = useGlobalPlayback();
  const { source } = playback;
  const { ref: attach, ...audioProps } = playback.audioProps;
  const { sourceRef } = playback;
  const attachAudio = useCallback(
    (audio: HTMLAudioElement | null) => {
      const cleanup = attach(audio);
      if (audio && sourceRef.current && !audio.getAttribute("src"))
        audio.src = apiUrl(`/recordings/${encodeURIComponent(sourceRef.current.id)}/audio`);
      return cleanup;
    },
    [attach, sourceRef],
  );
  return (
    <Card className="player-panel" ref={playback.panelRef} hidden={!source}>
      <CardContent>
        <div className="player-content">
          <div className="player-caption">
            {source && (
              <Link
                className="min-w-0 flex-1 truncate text-xs font-medium"
                title={source.title}
                to={
                  source.transcriptionId
                    ? `/recordings/${source.id}/transcriptions/${source.transcriptionId}`
                    : `/recordings/${source.id}`
                }
              >
                {source.title}
              </Link>
            )}
            <div ref={playback.setOutlineSlot} />
          </div>
          <audio
            {...audioProps}
            ref={attachAudio}
            controls
            preload="metadata"
            aria-label={tr("录音播放器")}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={tr("关闭播放器")}
            onClick={() => playback.close()}
          >
            <X />
          </Button>
          {source && playback.failed && (
            <div className="col-span-full flex items-center gap-2">
              <p className="text-sm text-destructive">
                {tr("音频暂时无法加载，请刷新会话或稍后重试。")}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  playback.pause();
                  playback.resetFailure();
                  playback.audioRef.current?.load();
                }}
              >
                {tr("重试")}
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
