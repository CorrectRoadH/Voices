// @concord-file
// @concord-implements docs/feature/transcription/use-case/transcribe.md
import { tr } from "@/lib/i18n";
import { useId, useState, useEffect } from "react";
import { Field, FieldGroup, FieldLabel, FieldDescription } from "./ui/field";
import { NativeSelect, NativeSelectOption } from "./ui/native-select";
import { Input } from "./ui/input";
import { Alert, AlertTitle, AlertDescription } from "./ui/alert";
import type { Options, Provider } from "@/lib/types";
export const blankOptions: Options = {
  provider: "",
  model: "",
  language_mode: "auto",
  languages: [],
  diarization: true,
};
export function optionError(
  options: Options,
  providers: Provider[],
  limits?: { duration_ms?: number; size_bytes?: number },
) {
  const provider = providers.find((p) => p.id === options.provider);
  const model = provider?.models.find((m) => m.id === options.model);
  if (!provider?.configured) return tr("请选择已配置的转写服务商。");
  if (!model) return tr("请选择模型。");
  if (!model.language_modes.includes(options.language_mode))
    return tr("该模型不支持所选语言模式，请调整或切换模型。");
  if (options.language_mode === "single" && options.languages.length !== 1)
    return tr("单语言模式需要选择一种语言。");
  if (options.language_mode === "multi" && options.languages.length < 2)
    return tr("多语言模式需要至少两种语言。");
  if (
    options.language_mode !== "auto" &&
    options.languages.some((l) => !model.languages.includes(l))
  )
    return tr("所选语言不在模型支持范围内，请调整语言或模型。");
  if (options.language_mode === "auto" && options.languages.length)
    return tr("自动检测模式请清空指定语言。");
  if (new Set(options.languages).size !== options.languages.length) return tr("语言代码不能重复。");
  if (
    options.provider === "assemblyai" &&
    options.model === "universal-2" &&
    options.language_mode === "multi" &&
    (options.languages.length !== 2 || !options.languages.includes("en"))
  )
    return tr("AssemblyAI Universal-2 多语言仅支持 en 加一种其他语言，请调整语言或切换模型。");
  if (!model.diarization)
    return tr("该模型不支持说话人区分，请切换模型。");
  if (
    limits?.duration_ms &&
    model.max_duration_ms > 0 &&
    limits.duration_ms > model.max_duration_ms
  )
    return tr("录音时长超过该模型限制，请选择其他模型。");
  if (limits?.size_bytes && model.max_file_bytes > 0 && limits.size_bytes > model.max_file_bytes)
    return tr("文件大小超过该模型限制，请选择其他模型。");
  return "";
}
export function OptionsFields({
  value,
  onChange,
  providers,
  compact = false,
}: {
  value: Options;
  onChange: (value: Options) => void;
  providers: Provider[];
  compact?: boolean;
}) {
  const id = useId();
  const [languageText, setLanguageText] = useState(value.languages.join(","));
  useEffect(() => {
    if (
      languageText
        .split(",")
        .map((l) => l.trim())
        .filter(Boolean)
        .join(",") !== value.languages.join(",")
    )
      setLanguageText(value.languages.join(","));
  }, [value.languages, languageText]);
  const provider = providers.find((p) => p.id === value.provider);
  const model = provider?.models.find((m) => m.id === value.model);
  useEffect(() => {
    if (!value.diarization) { onChange({ ...value, diarization: true }); return; }
    const selectedProvider = provider || (!value.provider ? providers.find((p) => p.configured) : undefined);
    const selectedModel = selectedProvider?.models[0];
    if (selectedProvider && selectedModel && (!value.provider || !value.model)) {
      onChange({ ...value, provider: selectedProvider.id, model: selectedModel.id });
    }
  }, [provider, providers, value, onChange]);
  const fields = (
    <FieldGroup>
      <div className="form-columns">
        <Field>
          <FieldLabel htmlFor={`${id}-provider`}>{tr("转写服务商")}</FieldLabel>
          <NativeSelect
            id={`${id}-provider`}
            value={value.provider}
            onChange={(e) => onChange({ ...value, provider: e.target.value, model: "", language_mode: "auto", languages: [] })}
          >
            <NativeSelectOption value="">{tr("选择服务商")}</NativeSelectOption>
            {providers.map((p) => (
              <NativeSelectOption key={p.id} value={p.id} disabled={!p.configured}>
                {p.name}
                {p.configured ? "" : tr(" · 未配置")}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-model`}>{tr("模型")}</FieldLabel>
          <NativeSelect
            id={`${id}-model`}
            value={value.model}
            onChange={(e) => onChange({ ...value, model: e.target.value })}
          >
            <NativeSelectOption value="">{tr("选择模型")}</NativeSelectOption>
            {provider?.models.map((m) => (
              <NativeSelectOption key={m.id} value={m.id}>
                {m.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor={`${id}-mode`}>{tr("语言模式")}</FieldLabel>
        <NativeSelect
          id={`${id}-mode`}
          value={value.language_mode}
            onChange={(e) => onChange({ ...value, language_mode: e.target.value as Options["language_mode"], languages: [] })}
        >
          <NativeSelectOption value="auto">{tr("自动检测")}</NativeSelectOption>
          <NativeSelectOption value="single">{tr("单语言")}</NativeSelectOption>
          <NativeSelectOption value="multi">{tr("多语言")}</NativeSelectOption>
        </NativeSelect>
      </Field>
      {value.provider === "assemblyai" &&
        value.model === "universal-2" &&
        value.language_mode === "multi" && (
          <FieldDescription>{tr("Universal-2 多语言仅支持英语（en）加一种其他语言。")}</FieldDescription>
        )}
      {value.language_mode !== "auto" && <Field>
        <FieldLabel htmlFor={`${id}-languages`}>{tr("语言代码")}</FieldLabel>
        <Input
          id={`${id}-languages`}
          placeholder={tr("例如 zh,en，用英文逗号分隔")}
          value={languageText}
          onChange={(e) => {
            setLanguageText(e.target.value);
            onChange({
              ...value,
              languages: e.target.value
                .split(",")
                .map((l) => l.trim())
                .filter(Boolean),
            });
          }}
        />
        <FieldDescription>
          {value.language_mode === "single" ? tr("填写一种语言，例如 zh（中文）。") : tr("用英文逗号分隔，例如 zh,en（中英混合）。")}
        </FieldDescription>
      </Field>}
      {model && (!model.timestamps || !model.diarization) && (
        <Alert>
          <AlertTitle>{tr("模型能力提示")}</AlertTitle>
          <AlertDescription>
            {!model.timestamps && tr("此模型无时间戳，不能跳转音频或导出 SRT。")}
            {!model.diarization && tr("此模型不区分说话人，可在转写后手动创建标签。")}{tr("文字编辑与人物关联始终可用。")}{" "}</AlertDescription>
        </Alert>
      )}
    </FieldGroup>
  );
  if (!compact) return fields;
  return <details className="rounded-lg border p-3">
    <summary className="cursor-pointer text-sm">{tr("转写选项 ·")}{" "}{model?.name || tr("未配置服务商")} · {value.language_mode === "auto" ? tr("自动检测语言") : value.languages.join(", ") || tr("指定语言")}</summary>
    <div className="pt-4">{fields}</div>
  </details>;
}
