import { useEffect, useId } from "react";
import { toast } from "@/components/ui/toast";
import { tr } from "@/lib/i18n";

export function useSaveToast(saving: boolean) {
  const id = useId();
  useEffect(() => {
    if (!saving) return;
    toast.add({ id, title: tr("正在自动保存…"), type: "loading", timeout: 0 });
    return () => toast.close(id);
  }, [saving, id]);
}
