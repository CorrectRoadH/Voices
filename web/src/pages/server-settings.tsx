// @concord-file
// @concord-implements docs/feature/accounts/use-case/manage-server.md
import { tr } from "@/lib/i18n";
import { ServerUpdates } from "@/components/server-updates";
import { LLMModelPicker } from "@/components/llm-model-picker";
import { useCallback, useEffect, useRef, useState } from "react";
import { Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSet } from "@/components/ui/field";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { ErrorBox, Loading, PageHeading } from "@/components/shared";
import { Spinner } from "@/components/ui/spinner";
import { useApp, useResource } from "@/lib/hooks";
import { errorMessage, HttpError, request } from "@/lib/api";
import type { Schema } from "@/lib/types";

type Response = Schema["ServerSettingsResponse"];
type Secret = { value: string; clear: boolean };
function SecretField({
  id,
  label,
  configured,
  active,
  secret,
  onChange,
}: {
  id: string;
  label: string;
  configured: boolean;
  active: boolean;
  secret: Secret;
  onChange: (secret: Secret) => void;
}) {
  return (
    <Field>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={id}>{label} API Key</FieldLabel>
        <Badge variant={configured ? "secondary" : "outline"}>
          {configured ? tr("已保存密钥") : tr("未配置")}
        </Badge>
      </div>
      <Input
        id={id}
        type="password"
        autoComplete="new-password"
        maxLength={8192}
        value={secret.value}
        disabled={secret.clear}
        placeholder={configured ? tr("留空保留已保存的密钥") : tr("输入 API Key")}
        onChange={(event) => onChange({ value: event.target.value, clear: false })}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        {active !== configured && (
          <FieldDescription>
            {tr("当前实例：")}
            {active ? tr("已配置") : tr("未配置")}
          </FieldDescription>
        )}
        {configured && (
          <Button
            type="button"
            size="sm"
            variant={secret.clear ? "destructive" : "outline"}
            onClick={() => onChange({ value: "", clear: !secret.clear })}
          >
            {secret.clear
              ? tr("取消清除 {{v0}} 密钥", { v0: label })
              : tr("清除 {{v0}} 密钥", { v0: label })}
          </Button>
        )}
      </div>
      {secret.clear && (
        <FieldDescription>
          {tr("清除后不会回退到环境配置；LLM 对新任务立即生效，STT 需重启。")}
        </FieldDescription>
      )}
    </Field>
  );
}

type Draft = {
  baseURL: string;
  origins: string;
  llmURL: string;
  model: string;
  soniox: Secret;
  assembly: Secret;
  llm: Secret;
};
function settingsPatch(draft: Draft, data: Response): Schema["ServerSettingsPatch"] | null {
  const patch: Schema["ServerSettingsPatch"] = { revision: data.revision };
  const baseURL = draft.baseURL.trim().replace(/\/+$/, "");
  const llmURL = draft.llmURL.trim().replace(/\/+$/, "");
  const origins = [
    ...new Set(
      draft.origins
        .split(/[\n,]/)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  if (baseURL !== data.saved.public_base_url) patch.public_base_url = baseURL;
  if (llmURL !== data.saved.llm_base_url) patch.llm_base_url = llmURL;
  if (draft.model.trim() !== data.saved.llm_model) patch.llm_model = draft.model.trim();
  if (JSON.stringify(origins) !== JSON.stringify(data.saved.allowed_origins))
    patch.allowed_origins = origins;
  for (const [key, secret] of [
    ["soniox_api_key", draft.soniox],
    ["assemblyai_api_key", draft.assembly],
    ["llm_api_key", draft.llm],
  ] as const) {
    if (secret.clear || secret.value) patch[key] = secret.clear ? "" : secret.value;
  }
  return Object.keys(patch).length > 1 ? patch : null;
}

export function ServerSettingsForm({
  data: initial,
  onboarding = false,
  onComplete,
}: {
  data: Response;
  onboarding?: boolean;
  onComplete?: () => void;
}) {
  const { session, notify } = useApp();
  const [data, setData] = useState(initial);
  const [draft, setDraft] = useState<Draft>(() => ({
    baseURL: initial.saved.public_base_url,
    origins: initial.saved.allowed_origins.join("\n"),
    llmURL: initial.saved.llm_base_url,
    model: initial.saved.llm_model,
    soniox: { value: "", clear: false },
    assembly: { value: "", clear: false },
    llm: { value: "", clear: false },
  }));
  const { baseURL, origins, llmURL, model, soniox, assembly, llm } = draft;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [conflict, setConflict] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const latest = useRef(draft);
  const saved = useRef(initial);
  const inFlight = useRef(false);
  const failed = useRef(false);
  const conflicted = useRef(false);
  const composing = useRef(false);
  const mounted = useRef(true);
  const restore = useRef(session.restore_mode);
  restore.current = session.restore_mode;
  const [testing, setTesting] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [actionError, setActionError] = useState("");
  const [testedRevision, setTestedRevision] = useState<number | null>(
    initial.llm_tested ? initial.revision : null,
  );
  const locked = session.restore_mode || testing || finishing;
  const dirty = settingsPatch(draft, data) !== null;

  const save = useCallback(async () => {
    if (inFlight.current || failed.current || composing.current || restore.current) return;
    if (form.current && !form.current.checkValidity()) {
      setInvalid(true);
      return;
    }
    inFlight.current = true;
    try {
      while (!restore.current) {
        const submitted = latest.current;
        const patch = settingsPatch(submitted, saved.current);
        if (!patch || composing.current) break;
        if (mounted.current && form.current && !form.current.checkValidity()) {
          setInvalid(true);
          break;
        }
        if (mounted.current) {
          setSaving(true);
          setError("");
          setInvalid(false);
        }
        const body = JSON.stringify(patch);
        const result = await request<Response>("/admin/server-settings", {
          method: "PATCH",
          body,
          keepalive: new TextEncoder().encode(body).length < 60000,
        });
        saved.current = result;
        const next = { ...latest.current };
        for (const key of ["soniox", "assembly", "llm"] as const) {
          if (next[key] === submitted[key]) next[key] = { value: "", clear: false };
        }
        latest.current = next;
        if (mounted.current) {
          setData(result);
          setDraft(next);
        }
      }
    } catch (cause) {
      failed.current = true;
      conflicted.current =
        cause instanceof HttpError && cause.status === 409 && cause.code === "conflict";
      if (mounted.current) {
        setConflict(conflicted.current);
        const message = conflicted.current
          ? tr("配置已被其它页面修改。当前输入尚未保存，请刷新页面后重新编辑。")
          : errorMessage(cause);
        setError(message);
        notify(message, true);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  }, []);

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setTestedRevision(null);
    setActionError("");
    latest.current = { ...latest.current, [key]: value };
    setDraft(latest.current);
    setInvalid(false);
    if (!conflicted.current) {
      failed.current = false;
      setError("");
    }
  }
  useEffect(() => {
    const timer = setTimeout(() => {
      void save();
    }, 800);
    return () => clearTimeout(timer);
  }, [draft, save]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void save();
    };
  }, [save]);
  const ready = !locked && !dirty && !saving && !error && !invalid;
  const tested = testedRevision === data.revision && !dirty;
  const emptyLLM = !data.saved.llm_base_url && !data.saved.llm_model && !data.saved.llm_configured;
  async function testLLM() {
    if (!ready) return;
    setTesting(true);
    setActionError("");
    setTestedRevision(null);
    try {
      const result = await request<{ revision: number; tested: boolean }>("/admin/llm-test", {
        method: "POST",
        body: JSON.stringify({ revision: data.revision }),
      });
      setTestedRevision(result.revision);
    } catch (cause) {
      const message = errorMessage(cause);
      setActionError(message);
      notify(message, true);
    } finally {
      setTesting(false);
    }
  }
  async function complete(skipLLM: boolean) {
    if (!ready) return;
    setFinishing(true);
    setActionError("");
    try {
      await request("/admin/onboarding", {
        method: "POST",
        body: JSON.stringify({ revision: data.revision, skip_llm: skipLLM }),
      });
      onComplete?.();
    } catch (cause) {
      const message = errorMessage(cause);
      setActionError(message);
      notify(message, true);
    } finally {
      setFinishing(false);
    }
  }
  return (
    <form
      ref={form}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      onCompositionStartCapture={() => {
        composing.current = true;
      }}
      onCompositionEndCapture={() => {
        composing.current = false;
        setDraft({ ...latest.current });
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) void save();
      }}
      className="flex flex-col gap-5"
    >
      <Alert>
        <Server />
        <AlertTitle>
          {data.restart_required ? tr("已保存，等待重启生效") : tr("数据库配置已在当前实例生效")}
        </AlertTitle>
        <AlertDescription>
          {tr(
            "LLM 保存后对新任务立即生效。站点和 STT 修改后需重启所有应用实例；当前状态仅代表本实例。",
          )}{" "}
        </AlertDescription>
      </Alert>
      {session.restore_mode && (
        <Alert>
          <AlertTitle>{tr("恢复核对模式")}</AlertTitle>
          <AlertDescription>{tr("当前仅可查看服务器配置。")}</AlertDescription>
        </Alert>
      )}
      <FieldSet disabled={locked}>
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{tr("站点")}</CardTitle>
              <CardDescription>{tr("用于访问地址、登录来源校验和引用链接。")}</CardDescription>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="public-base-url">{tr("站点 Base URL")}</FieldLabel>
                  <Input
                    id="public-base-url"
                    type="url"
                    required
                    maxLength={2048}
                    value={baseURL}
                    onChange={(e) => update("baseURL", e.target.value)}
                    placeholder="https://voices.example.com"
                  />
                  {data.active.public_base_url !== data.saved.public_base_url && (
                    <FieldDescription className="break-all">
                      {tr("当前生效：")}
                      {data.active.public_base_url}
                    </FieldDescription>
                  )}
                </Field>
                <Field>
                  <FieldLabel htmlFor="allowed-origins">{tr("额外可信来源")}</FieldLabel>
                  <Textarea
                    id="allowed-origins"
                    value={origins}
                    onChange={(e) => update("origins", e.target.value)}
                    rows={3}
                    placeholder="http://localhost:5173"
                  />
                  <FieldDescription>
                    {tr(
                      "每行一个完整来源，例如 https://voices.example.com；不能带路径或通配符。站点自身来源始终允许。",
                    )}
                  </FieldDescription>
                </Field>
              </FieldGroup>
            </CardContent>
            <CardFooter>
              <p className="text-sm text-muted-foreground">
                {tr(
                  "更换域名或协议前请配置代理；更改路径前还需同步前端构建路径，重启后从新地址访问。",
                )}
              </p>
            </CardFooter>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{tr("语音转写 · STT")}</CardTitle>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <SecretField
                  id="soniox-key"
                  label="Soniox"
                  configured={data.saved.soniox_configured}
                  active={data.active.soniox_configured}
                  secret={soniox}
                  onChange={(value) => update("soniox", value)}
                />
                <SecretField
                  id="assemblyai-key"
                  label="AssemblyAI"
                  configured={data.saved.assemblyai_configured}
                  active={data.active.assemblyai_configured}
                  secret={assembly}
                  onChange={(value) => update("assembly", value)}
                />
              </FieldGroup>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{tr("语言模型 · LLM")}</CardTitle>
              <CardDescription>{tr("用于生成摘要和目录，支持 OpenAI 兼容服务。")}</CardDescription>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="llm-base-url">LLM Base URL</FieldLabel>
                  <Input
                    id="llm-base-url"
                    type="url"
                    maxLength={2048}
                    value={llmURL}
                    onChange={(e) => update("llmURL", e.target.value)}
                    placeholder="https://your-provider.example/v1"
                  />
                </Field>
                <SecretField
                  id="llm-key"
                  label="LLM"
                  configured={data.saved.llm_configured}
                  active={data.active.llm_configured}
                  secret={llm}
                  onChange={(value) => update("llm", value)}
                />
                <LLMModelPicker
                  baseURL={llmURL}
                  apiKey={llm.clear ? "" : llm.value || undefined}
                  revision={data.revision}
                  value={model}
                  onChange={(value) => update("model", value)}
                  disabled={locked}
                  fetchDisabled={saving || dirty}
                />
              </FieldGroup>
            </CardContent>
          </Card>
        </div>
      </FieldSet>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">{tr("测试会调用模型，可能产生费用。")}</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            loading={testing}
            type="button"
            variant="outline"
            disabled={!ready || !data.saved.llm_base_url || !data.saved.llm_model}
            onClick={() => void testLLM()}
          >
            {testing ? tr("正在测试…") : tr("测试 LLM 连接")}
          </Button>
          <p role="status">{tested ? tr("当前配置测试通过") : tr("当前配置尚未通过测试")}</p>
        </div>
        {onboarding && (
          <div className="flex flex-wrap gap-3">
            <Button
              loading={finishing}
              type="button"
              disabled={!ready || !tested}
              onClick={() => void complete(false)}
            >
              {finishing ? tr("正在完成…") : tr("完成站点初始化")}
            </Button>
            <Button
              loading={finishing}
              type="button"
              variant="outline"
              disabled={!ready || !emptyLLM}
              onClick={() => void complete(true)}
            >
              {tr("暂不启用 LLM")}
            </Button>
            {!emptyLLM && (
              <p className="text-sm text-muted-foreground">
                {tr("暂不启用前，请清空 LLM 地址、模型和密钥。")}
              </p>
            )}
          </div>
        )}
      </div>
      <ErrorBox message={actionError} />
      <ErrorBox message={error} />
      {error && !conflict && (
        <Button
          type="button"
          variant="outline"
          disabled={saving || locked}
          onClick={() => {
            failed.current = false;
            void save();
          }}
        >
          {tr("重试自动保存")}
        </Button>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <p
          role="status"
          aria-live="polite"
          data-testid="settings-save-status"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          {saving && <Spinner />}
          {locked
            ? tr("恢复模式下仅可查看配置")
            : error
              ? tr("自动保存失败，修改尚未保存")
              : saving
                ? tr("正在自动保存…")
                : invalid
                  ? tr("部分字段格式不正确，尚未保存")
                  : dirty
                    ? tr("修改待保存…")
                    : tr("所有修改已保存")}
        </p>
      </div>
    </form>
  );
}

export function ServerSettingsPage() {
  const resource = useResource<Response>("/admin/server-settings");
  return (
    <>
      <PageHeading title={tr("服务器设置")} />
      <ServerUpdates />
      <ErrorBox message={resource.error} retry={resource.refresh} />
      {resource.loading ? (
        <Loading />
      ) : (
        resource.data && <ServerSettingsForm data={resource.data} />
      )}
    </>
  );
}
