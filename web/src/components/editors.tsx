// @concord-file
// @concord-implements docs/feature/transcription/README.md
// @concord-implements docs/feature/people/use-case/link-person.md
import { personName, labelName } from "@/lib/person-name";
import { tr } from "@/lib/i18n";
import { Check, X } from "lucide-react";
import { requestKey } from "@/lib/request-key";
import { useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Field, FieldGroup, FieldLabel, FieldDescription } from "./ui/field";
import { NativeSelect, NativeSelectOption } from "./ui/native-select";
import { Modal, ErrorBox } from "./shared";
import { write, request, HttpError } from "@/lib/api";
import { useAction } from "@/lib/hooks";
import type { Segment, Label, Person, Recording } from "@/lib/types";
export function SegmentEditor({
  segment,
  labels,
  people,
  onClose,
  onSaved,
}: {
  segment: Segment;
  labels: Label[];
  people: Person[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState(segment.text);
  const [start, setStart] = useState(
    segment.start_ms === null ? "" : String(segment.start_ms / 1000),
  );
  const [end, setEnd] = useState(segment.end_ms === null ? "" : String(segment.end_ms / 1000));
  const [assignment, setAssignment] = useState(
    segment.assignment_mode === "label"
      ? segment.speaker_label_id || "unknown"
      : segment.assignment_mode,
  );
  const action = useAction();
  const [invalid, setInvalid] = useState("");
  async function save(reset = false) {
    const startMs = start === "" ? null : Math.round(Number(start) * 1000);
    const endMs = end === "" ? null : Math.round(Number(end) * 1000);
    if (
      (startMs === null) !== (endMs === null) ||
      (startMs !== null &&
        (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs! < startMs))
    ) {
      setInvalid(tr("起止时间须同时填写或同时留空，结束不得早于开始。"));
      return;
    }
    const initialAssignment = segment.assignment_mode === "label" ? segment.speaker_label_id || "unknown" : segment.assignment_mode;
    if (!reset && text === segment.text && startMs === segment.start_ms && endMs === segment.end_ms && assignment === initialAssignment) {
      onClose();
      return;
    }
    const success = await action.run(
      () =>
        write(
          `/segments/${segment.id}`,
          "PATCH",
          reset
            ? { revision: segment.revision, edited_text: null }
            : {
                revision: segment.revision,
                ...(text !== segment.text ? { edited_text: text } : {}),
                start_ms: startMs,
                end_ms: endMs,
                assignment_mode: ["inherit", "unknown"].includes(assignment) ? assignment : "label",
                assigned_label_id: ["inherit", "unknown"].includes(assignment) ? null : assignment,
              },
        ),
      reset ? tr("已恢复原文") : tr("片段已保存"),
    );
    if (success) {
      onSaved();
      onClose();
    }
  }
  return (
    <Modal
      open
      onOpenChange={(v) => {
        if (!v && !action.busy) onClose();
      }}
      title={tr("编辑片段")}
      description={tr("修改校正文、时间与说话人归属，原始服务商文本会保留。")}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <FieldGroup>
          <ErrorBox message={action.error} />
          <Field>
            <FieldLabel htmlFor="segment-text">{tr("文字")}</FieldLabel>
            <Textarea
              id="segment-text"
              rows={5}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <FieldDescription>{tr("可留空表示人工删除文字。恢复原文可撤销文字校正。")}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="segment-assignment">{tr("说话人归属")}</FieldLabel>
            <NativeSelect
              id="segment-assignment"
              value={assignment}
              onChange={(e) => setAssignment(e.target.value)}
            >
              <NativeSelectOption value="inherit">{tr("继承原始标签")}</NativeSelectOption>
              <NativeSelectOption value="unknown">{tr("明确设为未知")}</NativeSelectOption>
              {labels.map((label) => (
                <NativeSelectOption value={label.id} key={label.id}>
                  {labelName(label, people)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <div className="form-columns">
            <Field>
              <FieldLabel htmlFor="segment-start">{tr("开始（秒）")}</FieldLabel>
              <Input
                id="segment-start"
                type="number"
                min="0"
                step="0.001"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="segment-end">{tr("结束（秒）")}</FieldLabel>
              <Input
                id="segment-end"
                type="number"
                min="0"
                step="0.001"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </Field>
          </div>
          <FieldDescription>{tr("无时间戳时两项均留空，不会生成虚构时间。")}</FieldDescription>
          {invalid && (
            <p className="text-sm text-destructive" role="alert">
              {invalid}
            </p>
          )}
          <details>
            <summary className="text-sm text-muted-foreground">{tr("查看原文")}</summary>
            <p className="whitespace-pre-wrap py-2 text-sm">{segment.source_text}</p>
          </details>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={action.busy || segment.edited_text === null}
              onClick={() => void save(true)}
            >{tr("恢复原文")}{" "}</Button>
            <Button variant="outline" type="button" disabled={action.busy} onClick={onClose}>{tr("取消")}{" "}</Button>
            <Button type="submit" disabled={action.busy}>{tr("保存修改")}{" "}</Button>
          </div>
        </FieldGroup>
      </form>
    </Modal>
  );
}
function LabelForm({
  label,
  people,
  onSaved,
}: {
  label: Label;
  people: Person[];
  onSaved: () => void;
}) {
  const [name, setName] = useState(label.display_name);
  const [person, setPerson] = useState(label.person_id || "");
  const action = useAction();
  return (
    <form
      className="label-form"
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => {
          await write(`/speaker-labels/${label.id}`, "PATCH", {
            revision: label.revision,
            display_name: name,
            person_id: person || null,
          });
          onSaved();
        }, tr("标签已更新"));
      }}
    >
      <FieldGroup>
        <ErrorBox message={action.error} />
        <Field>
          <FieldLabel htmlFor={`label-${label.id}`}>{tr("标签名称")}{label.provider_label && ` · ${label.provider_label}`}
          </FieldLabel>
          <Input
            id={`label-${label.id}`}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`person-${label.id}`}>{tr("关联人物")}</FieldLabel>
          <NativeSelect
            id={`person-${label.id}`}
            value={person}
            onChange={(e) => setPerson(e.target.value)}
          >
            <NativeSelectOption value="">{tr("不关联人物")}</NativeSelectOption>
            {people.map((p) => (
              <NativeSelectOption
                key={p.id}
                value={p.id}
                disabled={!!p.archived_at && p.id !== label.person_id}
              >
                {personName(p)}
                {p.archived_at ? tr("（已归档）") : ""}
              </NativeSelectOption>
            ))}
            {label.person_id && !people.some((p) => p.id === label.person_id) && (
              <NativeSelectOption value={label.person_id}>
                {label.person_name || tr("既有人物")}
              </NativeSelectOption>
            )}
          </NativeSelect>
        </Field>
        <Button variant="outline" type="submit" disabled={action.busy}>{tr("保存标签")}{" "}</Button>
      </FieldGroup>
    </form>
  );
}
export function LabelsEditor({
  labels,
  people,
  transcriptionId,
  onClose,
  onSaved,
}: {
  labels: Label[];
  people: Person[];
  transcriptionId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [person, setPerson] = useState("");
  const [key, setKey] = useState(() => requestKey());
  const action = useAction();
  return (
    <Modal
      open
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title={tr("说话人与人物")}
      description={tr("标签属于当前版本；关联人物后可在不同录音之间查找。归档人物保留原有关联。")}
    >
      <div className="flex flex-col gap-4">
        {labels.map((label) => (
          <LabelForm
            key={`${label.id}-${label.revision}`}
            label={label}
            people={people}
            onSaved={onSaved}
          />
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await write(
              `/transcriptions/${transcriptionId}/speaker-labels`,
              "POST",
              { display_name: name, person_id: person || null },
              key,
            );
            setName("");
            setPerson("");
            setKey(requestKey());
            onSaved();
          }, tr("人工标签已创建"));
        }}
      >
        <FieldGroup>
          <ErrorBox message={action.error} />
          <Field>
            <FieldLabel htmlFor="new-label">{tr("创建人工标签")}</FieldLabel>
            <Input
              id="new-label"
              required
              placeholder={tr("例如：主持人")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="new-label-person">{tr("关联人物（可选）")}</FieldLabel>
            <NativeSelect
              id="new-label-person"
              value={person}
              onChange={(e) => setPerson(e.target.value)}
            >
              <NativeSelectOption value="">{tr("暂不关联")}</NativeSelectOption>
              {people
                .filter((p) => !p.archived_at)
                .map((p) => (
                  <NativeSelectOption key={p.id} value={p.id}>
                    {personName(p)}
                  </NativeSelectOption>
                ))}
            </NativeSelect>
          </Field>
          <Button disabled={action.busy} type="submit">{tr("添加标签")}{" "}</Button>
        </FieldGroup>
      </form>
    </Modal>
  );
}
export function RecordingEditor({
  recording,
  onClose,
  onSaved,
  timeOnly = false,
}: {
  timeOnly?: boolean;
  recording: Recording;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [base] = useState(recording);
  const [title, setTitle] = useState(recording.title);
  const [notes, setNotes] = useState(recording.notes);
  const local = new Date(
    new Date(base.recorded_at).getTime() -
      new Date(base.recorded_at).getTimezoneOffset() * 60000,
  )
    .toISOString()
    .slice(0, 19);
  const [recordedAt, setRecordedAt] = useState(local);
  const action = useAction();
  return (
    <section aria-label={tr("编辑录音信息")} className="my-5">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            const patch: Partial<Pick<Recording, "title" | "notes" | "recorded_at">> = {};
            if (title !== base.title) patch.title = title;
            if (notes !== base.notes) patch.notes = notes;
            if (recordedAt !== local) patch.recorded_at = new Date(recordedAt).toISOString();
            if (Object.keys(patch).length) {
              try {
                await write(`/recordings/${base.id}`, "PATCH", { ...patch, revision: base.revision });
              } catch (error) {
                if (!(error instanceof HttpError) || error.status !== 409) throw error;
                const latest = await request<Recording>(`/recordings/${base.id}`);
                const changed = (Object.keys(patch) as (keyof typeof patch)[])
                  .some((key) => latest[key] !== base[key]);
                if (changed) throw new Error(tr("同一字段已被修改，你的输入已保留。请取消编辑并核对最新内容后再保存。"));
                await write(`/recordings/${base.id}`, "PATCH", { ...patch, revision: latest.revision });
              }
            }
            onSaved();
            onClose();
          }, tr("录音信息已更新"));
        }}
      >
        <FieldGroup>
          <ErrorBox message={action.error} />
          {!timeOnly && <Field>
            <FieldLabel htmlFor="recording-title">{tr("标题")}</FieldLabel>
            <Input
              id="recording-title"
              value={title}
              required
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>}
          <Field>
            <FieldLabel htmlFor="recorded-at">{tr("录音开始时间")}</FieldLabel>
            <Input
              id="recorded-at"
              type="datetime-local"
              step="1"
              required
              value={recordedAt}
              onChange={(e) => setRecordedAt(e.target.value)}
            />
          </Field>
          {!timeOnly && <Field>
            <FieldLabel htmlFor="recording-notes">{tr("备注")}</FieldLabel>
            <Textarea
              id="recording-notes"
              rows={4}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>}
          <div className="flex gap-2">
            <Button disabled={action.busy} type="submit">{tr("保存")}</Button>
            <Button disabled={action.busy} variant="outline" onClick={() => { onSaved(); onClose(); }}>{tr("取消")}</Button>
          </div>
        </FieldGroup>
      </form>
    </section>
  );
}

export function SegmentText({ segment, disabled, onSaved }: { segment: Segment; disabled: boolean; onSaved: (segment: Segment) => void }) {
  const [draft, setDraft] = useState<{text: string; original: string; revision: number; width: number} | null>(null);
  const action = useAction();
  if (!draft) return <button type="button" className="segment-text cursor-text text-left rounded-md focus-visible:outline-2 focus-visible:outline-ring" disabled={disabled} aria-label={tr("编辑这段文字")} onClick={(event) => setDraft({text:segment.text, original:segment.text, revision:segment.revision, width:Math.max(160, event.currentTarget.closest(".segment-bubble")!.getBoundingClientRect().width - 20)})}>{segment.text || <span className="text-muted-foreground">{tr("（此段文字已由人工清空）")}</span>}</button>;
  return <form className="segment-editor" style={{width:draft.width, maxWidth:"100%"}} onSubmit={(event) => { event.preventDefault(); if (action.busy) return; if (draft.text === draft.original) { setDraft(null); return; } void action.run(async () => { const saved = await write<Segment>(`/segments/${segment.id}`, "PATCH", {revision:draft.revision, edited_text:draft.text}); onSaved(saved); setDraft(null); }, tr("文字已保存")); }}>
    <Field><FieldLabel className="sr-only" htmlFor={`text-${segment.id}`}>{tr("片段文字")}</FieldLabel><Textarea id={`text-${segment.id}`} rows={1} autoFocus value={draft.text} disabled={action.busy} onChange={(event) => setDraft({...draft,text:event.target.value})} onKeyDown={(event) => { if (event.key === "Escape" && !action.busy) setDraft(null); if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) event.currentTarget.form?.requestSubmit(); }} /></Field>
    <ErrorBox message={action.error} />
    <div className="flex justify-end gap-1"><Button type="button" variant="ghost" size="icon-xs" aria-label={tr("取消编辑")} title={tr("取消（Esc）")} disabled={action.busy} onClick={() => setDraft(null)}><X /></Button><Button type="submit" variant="ghost" size="icon-xs" aria-label={tr("保存文字")} title={tr("保存（Ctrl/⌘+Enter）")} disabled={action.busy || disabled}><Check /></Button></div>
  </form>;
}
