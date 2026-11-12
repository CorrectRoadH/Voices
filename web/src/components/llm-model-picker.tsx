// @concord-file
// @concord-implements docs/feature/accounts/use-case/manage-server.md
import { Spinner } from "@/components/ui/spinner";
import { tr } from "@/lib/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  Combobox,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
} from "@/components/ui/combobox";
import { Button } from "@/components/ui/button";

import { Field, FieldLabel } from "@/components/ui/field";
import { ErrorBox } from "@/components/shared";
import { errorMessage, request } from "@/lib/api";
import { useApp } from "@/lib/hooks";
import type { Schema } from "@/lib/types";

export function LLMModelPicker({
  baseURL,
  apiKey,
  revision,
  value,
  onChange,
  disabled,
  fetchDisabled = false,
}: {
  baseURL: string;
  apiKey?: string;
  revision: number;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  fetchDisabled?: boolean;
}) {
  const { notify } = useApp();
  const connection = useMemo(() => ({ base_url: baseURL, api_key: apiKey }), [baseURL, apiKey]);
  const controller = useRef<AbortController | null>(null);
  const [result, setResult] = useState<{
    connection: typeof connection;
    items?: Schema["LLMModelsResponse"]["items"];
    error?: string;
  } | null>(null);
  const [pending, setPending] = useState<typeof connection | null>(null);
  useEffect(() => {
    return () => {
      controller.current?.abort();
    };
  }, [connection]);
  const current = result?.connection === connection ? result : null;
  const busy = pending === connection;
  const models = current?.items?.map((model) => model.id) || [];
  async function fetchModels() {
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    setPending(connection);
    setResult(null);
    try {
      const response = await request<Schema["LLMModelsResponse"]>("/admin/llm-models", {
        method: "POST",
        body: JSON.stringify({ ...connection, revision }),
        signal: AbortSignal.any([active.signal, AbortSignal.timeout(25000)]),
      });
      if (!active.signal.aborted) {
        setResult({ connection, items: response.items });
        notify(
          response.items.length
            ? tr("已获取 {{v0}} 个模型。列表不代表已验证 Chat Completions 或 JSON 输出能力。", {
                v0: response.items.length,
              })
            : tr("服务返回空模型列表，请手动填写模型 ID。"),
        );
      }
    } catch (error) {
      if (!active.signal.aborted) {
        const message = errorMessage(error);
        setResult({ connection, error: message });
        notify(message, true);
      }
    } finally {
      if (!active.signal.aborted) setPending(null);
    }
  }
  return (
    <>
      <Field>
        <FieldLabel htmlFor="llm-model">{tr("模型名称")}</FieldLabel>
        <Combobox
          items={models}
          inputValue={value}
          onInputValueChange={(input, details) => {
            if (details.reason === "input-change") onChange(input);
          }}
          value={null}
          onValueChange={(model) => {
            if (model) onChange(model);
          }}
          filter={null}
          openOnInputClick
          disabled={disabled}
        >
          <ComboboxInput
            id="llm-model"
            maxLength={200}
            placeholder={tr("选择或填写模型 ID")}
            showTrigger={false}
          />
          {!!models.length && (
            <ComboboxContent>
              <ComboboxList>
                {(model: string) => (
                  <ComboboxItem key={model} value={model} className="break-all">
                    {model}
                  </ComboboxItem>
                )}
              </ComboboxList>
            </ComboboxContent>
          )}
        </Combobox>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            aria-busy={busy}
            type="button"
            variant="outline"
            disabled={disabled || fetchDisabled || busy || !baseURL.trim()}
            onClick={() => void fetchModels()}
          >
            {busy && <Spinner data-icon="inline-start" aria-hidden="true" />}
            <RefreshCw data-icon="inline-start" />
            {busy ? tr("正在获取模型…") : tr("获取 LLM 模型")}
          </Button>
        </div>
        <ErrorBox message={current?.error || ""} />
      </Field>
    </>
  );
}
