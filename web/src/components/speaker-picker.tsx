// @concord-file
// @concord-implements docs/feature/people/use-case/link-person.md
import { personName } from "@/lib/person-name";
import { tr } from "@/lib/i18n";
import { useId, useRef, useState, type ReactNode } from "react";
import { PersonAvatar } from "./person-avatar";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Field, FieldLabel } from "./ui/field";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverTitle,
  PopoverDescription,
} from "./ui/popover";
import { ErrorBox } from "./shared";
import { useAction } from "@/lib/hooks";
import { write } from "@/lib/api";
import { requestKey } from "@/lib/request-key";
import type { Label, Person } from "@/lib/types";

export function SpeakerPicker({
  label,
  name,
  people,
  disabled,
  onSaved,
  children,
  open: controlledOpen,
  onOpenChange,
}: {
  label: Label;
  name: string;
  people: Person[];
  disabled: boolean;
  onSaved: () => void;
  children?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = onOpenChange ?? setLocalOpen;
  const triggerId = useId();
  const [query, setQuery] = useState("");
  const pending = useRef<{ name: string; key: string; person?: Person } | null>(null);
  const action = useAction();
  const submitting = useRef(false);
  const id = useId();
  async function assign(personId: string | null, create = false) {
    if (submitting.current) return;
    submitting.current = true;
    const ok = await action.run(
      async () => {
        if (create) {
          const name = query.trim();
          if (!name) return;
          if (!pending.current || pending.current.name !== name)
            pending.current = { name, key: requestKey() };
          const attempt = pending.current;
          attempt.person ||= await write<Person>(
            "/people",
            "POST",
            { display_name: name, notes: "" },
            attempt.key,
          );
          personId = attempt.person.id;
        }
        await write(`/speaker-labels/${label.id}`, "PATCH", {
          revision: label.revision,
          person_id: personId,
        });
        onSaved();
      },
      tr("该说话人的所有片段已更新"),
      create ? "new" : personId || "unlink",
    );
    submitting.current = false;
    if (ok) setOpen(false);
  }
  return (
    <Popover
      triggerId={triggerId}
      open={open}
      onOpenChange={(value) => {
        if (!action.busy) setOpen(value);
      }}
    >
      <PopoverTrigger
        id={triggerId}
        render={
          <Button
            className={children ? "speaker-avatar-trigger" : "speaker-name-trigger"}
            variant="ghost"
            size={children ? "icon" : "sm"}
            disabled={disabled}
          />
        }
        aria-label={tr("更改说话人：{{v0}}", { v0: name })}
      >
        {children || <span className="max-w-40 truncate">{name}</span>}
      </PopoverTrigger>
      <PopoverContent align="start" initialFocus={false}>
        <PopoverTitle>{tr("选择人物")}</PopoverTitle>
        <PopoverDescription>{tr("更新当前版本中该说话人的全部片段。")}</PopoverDescription>
        <ErrorBox message={action.error} />
        <Field>
          <FieldLabel htmlFor={id} className="sr-only">
            {tr("搜索或新建人物")}
          </FieldLabel>
          <Input
            id={id}
            type="search"
            name="speaker-filter"
            autoComplete="off"
            data-1p-ignore="true"
            data-lpignore="true"
            placeholder={tr("搜索人物")}
            value={query}
            disabled={action.busy}
            onChange={(e) => setQuery(e.target.value)}
          />
        </Field>
        <div className="grid max-h-60 grid-cols-2 gap-1 overflow-y-auto">
          {people
            .filter(
              (p) => !p.archived_at && personName(p).toLowerCase().includes(query.toLowerCase()),
            )
            .sort((a, b) => Number(!!b.builtin_key) - Number(!!a.builtin_key))
            .map((p) => (
              <Button
                className="min-w-0 h-auto justify-start py-2"
                title={personName(p)}
                aria-label={`${personName(p)}${p.builtin_key ? tr(" · 内置") : ""}`}
                key={p.id}
                loading={action.pendingKey === p.id}
                variant={label.person_id === p.id ? "secondary" : "ghost"}
                disabled={action.busy}
                onClick={() => void assign(p.id)}
              >
                <PersonAvatar id={p.id} name={personName(p)} person={p} />
                <span className="truncate">
                  {personName(p)}
                  {p.builtin_key ? tr(" · 内置") : ""}
                </span>
              </Button>
            ))}
        </div>
        {query.trim() && (
          <Button
            loading={action.pendingKey === "new"}
            disabled={action.busy}
            onClick={() => void assign(null, true)}
          >
            {tr("新建并关联“{{name}}”", { name: query.trim() })}
          </Button>
        )}
        {label.person_id && (
          <Button
            loading={action.pendingKey === "unlink"}
            variant="ghost"
            disabled={action.busy}
            onClick={() => void assign(null)}
          >
            {tr("解除人物关联")}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
