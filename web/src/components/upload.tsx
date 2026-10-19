// @concord-file
// @concord-implements docs/feature/recording-library/use-case/import-audio.md
import { tr } from "@/lib/i18n";
import { requestKey } from "@/lib/request-key";
import { useEffect, useRef, useState } from "react";
import { UploadCloud, FileAudio, CheckCircle2, Plus } from "lucide-react";
import { Button } from "./ui/button";
import { Field, FieldGroup, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import { Progress } from "./ui/progress";
import { Modal } from "./shared";
import { OptionsFields, blankOptions, optionError } from "./options";
import { upload, errorMessage, type UploadMetadata } from "@/lib/api";
import { useApp } from "@/lib/hooks";
import type { Options, Provider, Settings } from "@/lib/types";
import { bytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Link } from "react-router-dom";
type Entry = {
  id: string;
  file: File;
  title: string;
  options: Options | null;
  metadata?: UploadMetadata;
  status: "waiting" | "uploading" | "done" | "error";
  progress: number;
  error?: string;
  recordingId?: string;
  existing?: boolean;
};
function makeEntry(file: File): Entry {
  return {
    id: requestKey(),
    file,
    title: file.name.replace(/\.[^.]+$/, ""),
    options: null,
    status: "waiting",
    progress: 0,
  };
}
export function UploadDialog({
  open,
  onOpenChange,
  providers,
  settings,
  onComplete,
  initialFiles,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  providers: Provider[];
  settings: Settings | null;
  onComplete: () => void;
  initialFiles?: File[];
}) {
  const [entries, setEntries] = useState<Entry[]>(() => (initialFiles || []).map(makeEntry));
  const [options, setOptions] = useState<Options>(settings?.default_transcription || blankOptions);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const controllers = useRef(new Set<AbortController>());
  const active = useRef(new Set<string>());
  const batchRunning = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const { notify } = useApp();
  const completed = useRef(false);
  useEffect(() => {
    if (!completed.current && entries.length > 0 && entries.every((entry) => entry.status === "done")) {
      completed.current = true;
      notify(tr("已导入 {{v0}} 个文件", { v0: entries.length }));
      onOpenChange(false);
    }
  }, [entries, notify, onOpenChange]);
  const add = (files: File[]) => setEntries((old) => [...old, ...files.map(makeEntry)]);
  useEffect(() => {
    const ownedControllers = controllers.current;
    return () => ownedControllers.forEach((controller) => controller.abort());
  }, []);
  const patch = (id: string, values: Partial<Entry>) =>
    setEntries((old) => old.map((e) => (e.id === id ? { ...e, ...values } : e)));
  const busy = entries.some((e) => e.status === "uploading");
  async function send(entry: Entry) {
    if (active.current.has(entry.id)) return;
    const chosen = entry.options || options;
    const metadata = entry.metadata || {
      title: entry.title,
      auto_transcribe: true,
      transcription_options: { ...chosen, diarization: true },
    };
    if (metadata.auto_transcribe) {
      const invalid = optionError(metadata.transcription_options!, providers, {
        size_bytes: entry.file.size,
      });
      if (invalid) {
        patch(entry.id, { status: "error", error: invalid });
        notify(`${entry.file.name}：${invalid}`, true);
        return;
      }
    }
    active.current.add(entry.id);
    const controller = new AbortController();
    controllers.current.add(controller);
    patch(entry.id, { status: "uploading", progress: 0, error: undefined, metadata });
    try {
      const result = await upload(
        entry.file,
        metadata,
        entry.id,
        (percent) => patch(entry.id, { progress: percent }),
        controller.signal,
      );
      patch(entry.id, {
        status: "done",
        progress: 100,
        recordingId: result.recording.id,
        existing: result.existing,
      });
      onComplete();
    } catch (e) {
      patch(entry.id, { status: "error", error: errorMessage(e) });
      if (!controller.signal.aborted) notify(`${entry.file.name}：${errorMessage(e)}`, true);
    } finally {
      controllers.current.delete(controller);
      active.current.delete(entry.id);
    }
  }
  async function start() {
    if (batchRunning.current) return;
    batchRunning.current = true;
    try {
      for (const entry of entries.filter((e) => e.status === "waiting")) await send(entry);
    } finally {
      batchRunning.current = false;
    }
  }
  return (
    <Modal
      title={tr("导入录音")}
      description={tr("支持批量导入；重复文件返回已有录音。")}
      open={open}
      onOpenChange={(value) => {
        if (!value && busy) {
          notify(tr("正在上传，请等待本批次完成。"), true);
          return;
        }
        onOpenChange(value);
      }}
    >
      <div
        className={cn("upload-zone", dragging && "is-dragging")}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          add(Array.from(e.dataTransfer.files));
        }}
      >
        <UploadCloud className="size-8 text-primary" />
        <strong>{tr("将音频拖到这里")}</strong>
        <span className="text-sm text-muted-foreground">MP3、M4A、WAV、FLAC、OGG、WebM</span>
        <Button variant="outline" onClick={() => input.current?.click()}>
          <Plus data-icon="inline-start" />{tr("选择文件")}{" "}</Button>
        <input
          ref={input}
          type="file"
          accept="audio/*,.m4a,.flac,.ogg,.webm"
          multiple
          className="sr-only"
          aria-label={tr("选择音频文件")}
          onChange={(e) => {
            add(Array.from(e.target.files || []));
            e.target.value = "";
          }}
        />
      </div>
      <OptionsFields compact value={options} onChange={setOptions} providers={providers} />
      <div className="flex flex-col gap-3">
        {entries.map((entry) => (
          <section className="upload-file" key={entry.id}>
            <div className="flex items-start gap-3">
              <FileAudio className="mt-1 size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{entry.file.name}</p>
                <p className="text-xs text-muted-foreground">
                  {bytes(entry.file.size)} ·{" "}
                  {entry.status === "uploading"
                    ? entry.progress === 100
                      ? tr("已传输，正在校验与保存…")
                      : tr("上传中 {{v0}}%", { v0: entry.progress })
                    : entry.status === "done"
                      ? entry.existing
                        ? tr("重复文件 · 已有录音")
                        : tr("已保存")
                      : entry.status === "waiting"
                        ? tr("等待导入")
                        : tr("上传失败")}
                </p>
              </div>
              {entry.status === "done" ? <CheckCircle2 className="size-5 text-primary" /> : null}
            </div>
            {entry.status === "uploading" && (
              <Progress value={entry.progress} aria-label={tr("{{v0}} 上传进度", { v0: entry.file.name })} />
            )}
            {entry.error && (
              <p className="text-sm text-destructive" role="alert">
                {entry.error}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {entry.status === "waiting" && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setEditing(editing === entry.id ? null : entry.id)}
                  >{tr("录音标题与选项")}{" "}</Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setEntries((old) => old.filter((e) => e.id !== entry.id))}
                  >{tr("移除")}{" "}</Button>
                </>
              )}
              {entry.status === "error" && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void send(entry)}
                >{tr("重新上传")}{" "}</Button>
              )}
              {entry.recordingId && (
                <Button
                  variant="link"
                  size="sm"
                  nativeButton={false}
                  render={
                    <Link
                      to={`/recordings/${entry.recordingId}`}
                      onClick={() => onOpenChange(false)}
                    />
                  }
                >{tr("查看录音")}{" "}</Button>
              )}
            </div>
            {editing === entry.id && entry.status === "waiting" && (
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor={`title-${entry.id}`}>{tr("录音标题")}</FieldLabel>
                  <Input
                    id={`title-${entry.id}`}
                    value={entry.title}
                    onChange={(e) => patch(entry.id, { title: e.target.value })}
                  />
                </Field>
                {(
                  <OptionsFields
                    providers={providers}
                    value={entry.options || options}
                    onChange={(value) => patch(entry.id, { options: value })}
                  />
                )}
              </FieldGroup>
            )}
          </section>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>{tr("关闭")}{" "}</Button>
        <Button
          disabled={busy || !entries.some((e) => e.status === "waiting")}
          onClick={() => void start()}
        >
          <UploadCloud data-icon="inline-start" />
          {busy ? tr("正在导入…") : tr("开始导入")}
        </Button>
      </div>
    </Modal>
  );
}
