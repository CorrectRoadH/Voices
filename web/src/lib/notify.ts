import { toast } from "@/components/ui/toast";
import { tr } from "@/lib/i18n";

export function notify(text: string, isError = false) {
  return toast.add({
    id: `${isError ? "error" : "success"}:${text}`,
    title: isError ? tr("操作未完成") : tr("已完成"),
    description: text,
    type: isError ? "error" : "success",
    priority: isError ? "high" : "low",
    timeout: isError ? 0 : 4500,
  });
}
