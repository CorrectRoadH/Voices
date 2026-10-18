// @concord-file
// @concord-implements docs/feature/accounts/use-case/manage-server.md
import { ServerUpdates } from "@/components/server-updates";
import { useState, type FormEvent } from "react";
import { Save, Server, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSet } from "@/components/ui/field";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { ErrorBox, Loading, PageHeading } from "@/components/shared";
import { useAction, useApp, useResource } from "@/lib/hooks";
import { write } from "@/lib/api";
import type { Schema } from "@/lib/types";

type Response = Schema["ServerSettingsResponse"];
type Secret = { value: string; clear: boolean };
function SecretField({ id, label, configured, active, secret, onChange }: {
  id: string; label: string; configured: boolean; active: boolean;
  secret: Secret; onChange: (secret: Secret) => void;
}) {
  return <Field>
    <div className="flex items-center justify-between gap-2">
      <FieldLabel htmlFor={id}>{label} API Key</FieldLabel>
      <Badge variant={configured ? "secondary" : "outline"}>{configured ? "已保存密钥" : "未配置"}</Badge>
    </div>
    <Input id={id} type="password" autoComplete="new-password" maxLength={8192}
      value={secret.value} disabled={secret.clear} placeholder={configured ? "留空保留已保存的密钥" : "输入 API Key"}
      onChange={(event) => onChange({ value: event.target.value, clear: false })} />
    <div className="flex flex-wrap items-center justify-between gap-2">
      <FieldDescription>当前实例：{active ? "已配置" : "未配置"}。密钥不会回显。</FieldDescription>
      {configured && <Button type="button" size="sm" variant={secret.clear ? "destructive" : "outline"}
        onClick={() => onChange({ value: "", clear: !secret.clear })}>
        {secret.clear ? `取消清除 ${label} 密钥` : `清除 ${label} 密钥`}
      </Button>}
    </div>
    {secret.clear && <FieldDescription>保存后清除密钥，重启后停止使用；不会回退到 .env。</FieldDescription>}
  </Field>;
}

function ServerSettingsForm({ data, onSaved, refresh }: { data: Response; onSaved: (data: Response) => void; refresh: () => void }) {
  const { session } = useApp();
  const action = useAction();
  const [baseURL, setBaseURL] = useState(data.saved.public_base_url);
  const [origins, setOrigins] = useState(data.saved.allowed_origins.join("\n"));
  const [llmURL, setLLMURL] = useState(data.saved.llm_base_url);
  const [model, setModel] = useState(data.saved.llm_model);
  const [soniox, setSoniox] = useState<Secret>({ value: "", clear: false });
  const [assembly, setAssembly] = useState<Secret>({ value: "", clear: false });
  const [llm, setLLM] = useState<Secret>({ value: "", clear: false });
  const locked = session.restore_mode || action.busy;
  async function save(event: FormEvent) {
    event.preventDefault();
    const patch: Schema["ServerSettingsPatch"] = {
      revision: data.revision, public_base_url: baseURL,
      allowed_origins: origins.split(/[\n,]/).map((value) => value.trim()).filter(Boolean),
      llm_base_url: llmURL, llm_model: model,
    };
    for (const [key, secret] of [["soniox_api_key", soniox], ["assemblyai_api_key", assembly], ["llm_api_key", llm]] as const) {
      if (secret.clear || secret.value) patch[key] = secret.clear ? "" : secret.value;
    }
    await action.run(async () => {
      const result = await write<Response>("/admin/server-settings", "PATCH", patch);
      onSaved(result);
    }, "配置已保存到数据库");
  }
  return <form onSubmit={save} className="flex flex-col gap-5">
    <Alert>
      <Server />
      <AlertTitle>{data.restart_required ? "已保存，等待重启生效" : "数据库配置已在当前实例生效"}</AlertTitle>
      <AlertDescription>
        数据库配置优先于 .env；.env 仅用于首次导入。保存后请重启所有应用实例。
        此状态仅代表当前实例，不代表其它副本。
      </AlertDescription>
    </Alert>
    {session.restore_mode && <Alert><AlertTitle>恢复核对模式</AlertTitle><AlertDescription>当前仅可查看服务器配置。</AlertDescription></Alert>}
    <FieldSet disabled={locked}>
      <div className="settings-grid">
        <Card>
          <CardHeader><CardTitle>站点</CardTitle><CardDescription>用于访问地址、登录来源校验和引用链接。</CardDescription></CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="public-base-url">站点 Base URL</FieldLabel>
                <Input id="public-base-url" type="url" required maxLength={2048} value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder="https://voices.example.com" />
                <FieldDescription className="break-all">当前生效：{data.active.public_base_url}</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="allowed-origins">额外可信来源</FieldLabel>
                <Textarea id="allowed-origins" value={origins} onChange={(e) => setOrigins(e.target.value)} rows={3} placeholder="http://localhost:5173" />
                <FieldDescription>每行一个完整来源，例如 https://voices.example.com；不能带路径或通配符。站点自身来源始终允许。</FieldDescription>
              </Field>
            </FieldGroup>
          </CardContent>
          <CardFooter><p className="text-sm text-muted-foreground">更换域名或协议前请配置代理；更改路径前还需同步前端构建路径，重启后从新地址访问。</p></CardFooter>
        </Card>
        <Card>
          <CardHeader><CardTitle>语音转写 · STT</CardTitle><CardDescription>所有账号共用服务器配置的转写服务额度。</CardDescription></CardHeader>
          <CardContent><FieldGroup>
            <SecretField id="soniox-key" label="Soniox" configured={data.saved.soniox_configured} active={data.active.soniox_configured} secret={soniox} onChange={setSoniox} />
            <SecretField id="assemblyai-key" label="AssemblyAI" configured={data.saved.assemblyai_configured} active={data.active.assemblyai_configured} secret={assembly} onChange={setAssembly} />
          </FieldGroup></CardContent>
          <CardFooter><p className="text-sm text-muted-foreground">更换服务商账号前，先完成旧账号的转写及远端清理。已配置不代表连接已验证。</p></CardFooter>
        </Card>
        <Card>
          <CardHeader><CardTitle>语言模型 · LLM</CardTitle><CardDescription>配置兼容 OpenAI 接口的服务。本期仅保存配置，尚未接入摘要或文本整理。</CardDescription></CardHeader>
          <CardContent><FieldGroup>
            <Field><FieldLabel htmlFor="llm-base-url">LLM Base URL</FieldLabel>
              <Input id="llm-base-url" type="url" maxLength={2048} value={llmURL} onChange={(e) => setLLMURL(e.target.value)} placeholder="https://your-provider.example/v1" />
              <FieldDescription>填写服务提供的 API 基础地址，可包含 /v1。</FieldDescription>
            </Field>
            <Field><FieldLabel htmlFor="llm-model">模型名称</FieldLabel>
              <Input id="llm-model" maxLength={200} value={model} onChange={(e) => setModel(e.target.value)} placeholder="服务商提供的模型 ID" />
            </Field>
            <SecretField id="llm-key" label="LLM" configured={data.saved.llm_configured} active={data.active.llm_configured} secret={llm} onChange={setLLM} />
          </FieldGroup></CardContent>
          <CardFooter><p className="text-sm text-muted-foreground">保存不会调用模型，也不会产生模型调用费用。</p></CardFooter>
        </Card>
      </div>
    </FieldSet>
    <ErrorBox message={action.error} />
    <div className="flex flex-wrap items-center gap-3">
      <Button type="submit" disabled={locked}><Save data-icon="inline-start" />{action.busy ? "正在保存…" : "保存服务器配置"}</Button>
      <Button type="button" variant="outline" disabled={action.busy} onClick={refresh}><RotateCcw data-icon="inline-start" />重新加载已保存配置</Button>
      <p className="text-sm text-muted-foreground">密钥保存在数据库中，数据库及备份需按含凭据保护。</p>
    </div>
  </form>;
}

export function ServerSettingsPage() {
  const resource = useResource<Response>("/admin/server-settings");
  const [generation, setGeneration] = useState(0);
  return <>
    <PageHeading title="服务器设置" />
    <ServerUpdates />
    <ErrorBox message={resource.error} retry={resource.refresh} />
    {resource.loading ? <Loading /> : resource.data && <ServerSettingsForm key={`${generation}:${resource.data.revision}`} data={resource.data}
      onSaved={(data) => resource.setData(data)} refresh={() => { setGeneration((n) => n + 1); resource.refresh(); }} />}
  </>;
}
