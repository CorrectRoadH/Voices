// @concord-file
// @concord-implements docs/feature/transcription/use-case/transcribe.md
import { useCallback, useEffect, useRef, useState } from "react";
import { tr } from "./i18n";
import { errorMessage } from "./api";
import type { Segment } from "./types";

export function useSegmentPlayback(sourceKey: string, onError: (message: string) => void) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const stopAt = useRef<number | null>(null);
  const playRequest = useRef(0);
  const frame = useRef(0);
  const [failed, setFailed] = useState(false);

  const stop = useCallback(() => {
    playRequest.current++;
    cancelAnimationFrame(frame.current);
    stopAt.current = null;
    pendingSeek.current = null;
  }, []);
  const pause = useCallback(() => {
    stop();
    audioRef.current?.pause();
  }, [stop]);
  const attachAudio = useCallback(
    (audio: HTMLAudioElement | null) => {
      audioRef.current = audio;
      if (!audio) return;
      return () => {
        stop();
        audio.pause();
        audioRef.current = null;
      };
    },
    [stop],
  );
  useEffect(() => {
    setFailed(false);
    return pause;
  }, [sourceKey, pause]);

  const flushSeek = useCallback(() => {
    const audio = audioRef.current;
    if (pendingSeek.current === null || !audio || audio.readyState < 1) return;
    audio.currentTime = pendingSeek.current;
    pendingSeek.current = null;
  }, []);
  const queueSeek = useCallback((milliseconds: number | null) => {
    pendingSeek.current = milliseconds === null ? null : milliseconds / 1000;
  }, []);
  const seek = useCallback(
    (milliseconds: number) => {
      queueSeek(milliseconds);
      flushSeek();
    },
    [queueSeek, flushSeek],
  );
  const watchPlayback = useCallback(function watch() {
    cancelAnimationFrame(frame.current);
    const audio = audioRef.current;
    if (!audio || audio.paused) return;
    if (stopAt.current !== null && audio.currentTime >= stopAt.current) {
      const end = stopAt.current;
      audio.pause();
      audio.currentTime = end;
      stopAt.current = null;
      return;
    }
    frame.current = requestAnimationFrame(watch);
  }, []);

  async function play(segment: Segment) {
    const audio = audioRef.current;
    if (segment.start_ms === null || !audio) return;
    pause();
    const requestId = playRequest.current;
    try {
      if (segment.end_ms === null || segment.end_ms <= segment.start_ms)
        throw new Error(tr("没有有效的结束时间，无法播放此范围。"));
      stopAt.current = segment.end_ms / 1000;
      seek(segment.start_ms);
      await audio.play();
    } catch (error) {
      if (requestId === playRequest.current) {
        stopAt.current = null;
        onError(errorMessage(error));
      }
    }
  }
  return {
    play,
    pause,
    seek,
    queueSeek,
    flushSeek,
    failed,
    audioProps: {
      ref: attachAudio,
      onLoadedMetadata: flushSeek,
      onPlay: watchPlayback,
      onPause: () => {
        if (audioRef.current?.paused) {
          cancelAnimationFrame(frame.current);
          stopAt.current = null;
        }
      },
      onTimeUpdate: () => {
        if (stopAt.current !== null) watchPlayback();
      },
      onError: () => setFailed(true),
    },
  };
}
