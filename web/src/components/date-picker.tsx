// @concord-file
// @concord-implements docs/feature/interface-interactions/ui.md
import { useEffect, useState, useRef, useImperativeHandle, type ComponentProps } from "react";
import { CalendarIcon } from "lucide-react";
import { zhCN, enUS } from "react-day-picker/locale";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
  InputGroupButton,
} from "@/components/ui/input-group";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { interfaceLocale, tr } from "@/lib/i18n";

// Compose the official date picker. Values stay local (no UTC conversion here).
export function DatePicker({
  value,
  onValueChange,
  dateOnly = false,
  id,
  disabled,
  ref,
  ...props
}: Omit<ComponentProps<typeof Input>, "value" | "onChange" | "type"> & {
  value: string;
  onValueChange: (value: string) => void;
  dateOnly?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => input.current!, []);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
    input.current?.setCustomValidity("");
  }, [value]);
  const pattern = dateOnly
    ? "[0-9]{4}-[0-9]{2}-[0-9]{2}"
    : "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2})?";
  const parsed = value ? new Date(dateOnly ? `${value}T00:00:00` : value) : undefined;
  const selected = parsed && !Number.isNaN(parsed.getTime()) ? parsed : undefined;
  const update = (next: string) => {
    input.current?.setCustomValidity("");
    setDraft(next);
    if (
      !next ||
      (new RegExp(`^${pattern}$`).test(next) &&
        !Number.isNaN(new Date(dateOnly ? `${next}T00:00:00` : next).getTime()))
    )
      onValueChange(next);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <InputGroup>
        <InputGroupInput
          {...props}
          ref={input}
          id={id}
          value={draft}
          disabled={disabled}
          pattern={pattern}
          placeholder={dateOnly ? "YYYY-MM-DD" : "YYYY-MM-DDTHH:mm"}
          onChange={(event) => {
            const next = event.target.value;
            const parsed = new Date(dateOnly ? `${next}T00:00:00` : next);
            const valid =
              !next ||
              (new RegExp(`^${pattern}$`).test(next) &&
                !Number.isNaN(parsed.getTime()) &&
                parsed.getFullYear() === Number(next.slice(0, 4)) &&
                parsed.getMonth() + 1 === Number(next.slice(5, 7)) &&
                parsed.getDate() === Number(next.slice(8, 10)));
            event.target.setCustomValidity(valid ? "" : tr("部分字段格式不正确，尚未保存"));
            if (valid) update(next);
            else setDraft(next);
          }}
        />
        <InputGroupAddon align="inline-end">
          <PopoverTrigger
            render={
              <InputGroupButton disabled={disabled} size="icon-xs" aria-label={tr("选择日期")} />
            }
          >
            <CalendarIcon />
          </PopoverTrigger>
        </InputGroupAddon>
      </InputGroup>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          disabled={disabled}
          selected={selected}
          defaultMonth={selected}
          locale={interfaceLocale() === "zh-CN" ? zhCN : enUS}
          onSelect={(day) => {
            if (!day) return;
            const local = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
            update(dateOnly ? local : `${local}T${value.split("T")[1] || "00:00"}`);
            if (dateOnly) setOpen(false);
          }}
        />
        <div className="flex flex-col gap-3 p-3">
          {!dateOnly && (
            <Field>
              <FieldLabel htmlFor={`${id}-time`}>{tr("时间")}</FieldLabel>
              <Input
                id={`${id}-time`}
                aria-label={tr("时间")}
                placeholder="HH:mm"
                inputMode="numeric"
                pattern="([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?"
                defaultValue={value.split("T")[1] || "00:00"}
                key={value.split("T")[0]}
                disabled={disabled || !selected}
                onChange={(event) => {
                  if (event.target.validity.valid && event.target.value)
                    update(`${value.split("T")[0]}T${event.target.value}`);
                }}
              />
            </Field>
          )}
          <div className="flex justify-between gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => {
                update("");
                setOpen(false);
              }}
            >
              {tr("清除")}
            </Button>
            <Button size="sm" onClick={() => setOpen(false)}>
              {tr("完成")}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
