// @concord-file
// @concord-implements docs/feature/appearance/README.md
// @concord-implements docs/feature/transcription/use-case/transcribe.md
import { useId, useRef, useState, type ReactNode } from "react";
import { Check, Pencil, X } from "lucide-react";
import { cn } from "cn";
import { tr } from "@/lib/i18n";
import { useAction } from "@/lib/hooks";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Field, FieldLabel, FieldDescription } from "./ui/field";
import { ErrorBox } from "./shared";

type InlineEditProps = {
  value: string;
  displayValue?: ReactNode;
  label: string;
  editLabel: string;
  saveLabel?: string;
  description?: string;
  multiline?: boolean;
  required?: boolean;
  disabled?: boolean;
  heading?: boolean;
  compact?: boolean;
  type?: "text" | "datetime-local";
  className?: string;
  onSave: (value: string) => Promise<void>;
  onCancel?: () => void;
  successMessage?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export function InlineEdit(props: InlineEditProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const display = useRef<HTMLSpanElement>(null);
  const [session, setSession] = useState<{ props: InlineEditProps; width: number } | null>(null);
  function close() {
    setSession(null);
    props.onOpenChange?.(false);
    if (props.onOpenChange) {
      requestAnimationFrame(() =>
        display.current
          ?.closest("article")
          ?.querySelector<HTMLButtonElement>(".message-more")
          ?.focus(),
      );
    }
    requestAnimationFrame(() => trigger.current?.focus());
  }
  if (session || props.open)
    return (
      <InlineEditSession
        {...(session?.props ?? props)}
        disabled={props.disabled}
        width={session?.width ?? display.current?.getBoundingClientRect().width ?? 240}
        onClose={close}
      />
    );
  if (props.onOpenChange)
    return (
      <span ref={display} className={props.className}>
        {props.displayValue ?? props.value}
      </span>
    );
  const control = (
    <button
      ref={trigger}
      type="button"
      className={cn("inline-edit-trigger", props.className)}
      aria-label={props.editLabel}
      disabled={props.disabled}
      onClick={(event) =>
        setSession({ props, width: event.currentTarget.getBoundingClientRect().width })
      }
    >
      {props.displayValue ?? props.value}
      {!props.compact && <Pencil className="inline-edit-pencil" aria-hidden="true" />}
    </button>
  );
  return props.heading ? (
    <h1 aria-label={typeof props.displayValue === "string" ? props.displayValue : props.value}>
      {control}
    </h1>
  ) : (
    control
  );
}

function InlineEditSession(props: InlineEditProps & { width: number; onClose: () => void }) {
  // Keep the revision-bearing save callback from the moment editing began.
  const [initial] = useState(props);
  return <InlineEditForm {...initial} disabled={props.disabled} onClose={props.onClose} />;
}

function InlineEditForm({
  value,
  label,
  editLabel,
  saveLabel = tr("保存"),
  description,
  multiline,
  required,
  disabled,
  compact,
  type = "text",
  onSave,
  onCancel,
  successMessage,
  width,
  onClose,
}: InlineEditProps & { width: number; onClose: () => void }) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const action = useAction();
  function cancel() {
    if (action.busy) return;
    onCancel?.();
    onClose();
  }
  return (
    <form
      className={cn("inline-edit-form", compact && "segment-editor")}
      style={compact ? { width: Math.max(160, width), maxWidth: "100%" } : undefined}
      aria-label={editLabel}
      aria-busy={action.busy}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) {
          if (event.key === "Enter") event.preventDefault();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancel();
        }
        const input =
          event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
        if (input && event.key === "Enter" && (!multiline || event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          if (!action.busy) event.currentTarget.requestSubmit();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (action.busy || disabled) return;
        if (draft === value) {
          cancel();
          return;
        }
        void action
          .run(() => onSave(draft), successMessage)
          .then((saved) => {
            if (saved) onClose();
            else
              requestAnimationFrame(() =>
                (multiline ? textareaRef.current : inputRef.current)?.focus(),
              );
          });
      }}
    >
      <div className={cn("flex gap-2", multiline ? "flex-col" : "items-start")}>
        <Field className="min-w-0 flex-1 gap-1">
          <FieldLabel className="sr-only" htmlFor={id}>
            {label}
          </FieldLabel>
          {multiline ? (
            <Textarea
              ref={textareaRef}
              id={id}
              autoFocus
              rows={compact ? 1 : 3}
              value={draft}
              disabled={action.busy || disabled}
              onChange={(event) => setDraft(event.target.value)}
            />
          ) : (
            <Input
              ref={inputRef}
              id={id}
              autoFocus
              type={type}
              step={type === "datetime-local" ? "1" : undefined}
              required={required}
              value={draft}
              disabled={action.busy || disabled}
              onChange={(event) => setDraft(event.target.value)}
            />
          )}
          {description && <FieldDescription>{description}</FieldDescription>}
        </Field>
        <div className="flex shrink-0 justify-end gap-1">
          <Button
            type="submit"
            size={compact ? "icon-xs" : "icon"}
            variant="ghost"
            aria-label={saveLabel}
            title={multiline ? tr("保存（Ctrl/⌘+Enter）") : tr("保存")}
            loading={action.busy}
            disabled={disabled}
          >
            {!action.busy && <Check />}
          </Button>
          <Button
            type="button"
            size={compact ? "icon-xs" : "icon"}
            variant="ghost"
            aria-label={tr("取消编辑")}
            title={tr("取消（Esc）")}
            disabled={action.busy}
            onClick={cancel}
          >
            <X />
          </Button>
        </div>
      </div>
      <ErrorBox message={action.error} />
    </form>
  );
}
