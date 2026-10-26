// @concord-file
// @concord-implements docs/feature/accounts/use-case/oidc-login.md#configure
import { useCallback, useEffect, useRef, useState } from "react";
import { tr } from "@/lib/i18n";
import { request, HttpError, errorMessage } from "@/lib/api";
import { useApp, useResource } from "@/lib/hooks";
import type { Schema } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Field, FieldGroup, FieldLabel, FieldDescription, FieldSet } from "@/components/ui/field";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { ErrorBox, Loading } from "@/components/shared";

type Settings = Schema["OIDCSettings"];
type Draft = Pick<Settings, "enabled" | "display_name" | "issuer_url" | "client_id"> & {
  secret: { value: string; clear: boolean };
};
function patchFor(draft: Draft, saved: Settings): Schema["OIDCSettingsPatch"] | null {
  const patch: Schema["OIDCSettingsPatch"] = { revision: saved.revision };
  if (draft.enabled !== saved.enabled) patch.enabled = draft.enabled;
  for (const key of ["display_name", "issuer_url", "client_id"] as const) {
    if (draft[key].trim() !== saved[key]) patch[key] = draft[key].trim();
  }
  if (draft.secret.value || draft.secret.clear)
    patch.client_secret = draft.secret.clear ? "" : draft.secret.value;
  return Object.keys(patch).length > 1 ? patch : null;
}
function OIDCSettingsForm({ initial }: { initial: Settings }) {
  const { session, notify } = useApp();
  const [data, setData] = useState(initial);
  const [draft, setDraft] = useState<Draft>({
    enabled: initial.enabled,
    display_name: initial.display_name,
    issuer_url: initial.issuer_url,
    client_id: initial.client_id,
    secret: { value: "", clear: false },
  });
  const [saving, setSaving] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const latest = useRef(draft);
  const saved = useRef(initial);
  const inFlight = useRef(false);
  const failed = useRef(false);
  const conflicted = useRef(false);
  const composing = useRef(false);
  const mounted = useRef(true);
  const form = useRef<HTMLFormElement>(null);
  const restore = useRef(session.restore_mode);
  restore.current = session.restore_mode;
  const save = useCallback(async () => {
    if (inFlight.current || failed.current || composing.current || restore.current) return;
    inFlight.current = true;
    try {
      while (!restore.current) {
        const submitted = latest.current;
        const patch = patchFor(submitted, saved.current);
        if (!patch || composing.current) break;
        const ready =
          !submitted.enabled ||
          (submitted.issuer_url.trim() &&
            submitted.client_id.trim() &&
            (submitted.secret.value ||
              (saved.current.client_secret_configured && !submitted.secret.clear)));
        if (
          !ready ||
          !submitted.display_name.trim() ||
          (form.current && !form.current.checkValidity())
        ) {
          if (mounted.current) setInvalid(true);
          break;
        }
        if (mounted.current) {
          setSaving(true);
          setError("");
          setInvalid(false);
        }
        const body = JSON.stringify(patch);
        const result = await request<Settings>("/admin/oidc", {
          method: "PATCH",
          body,
          keepalive: new TextEncoder().encode(body).length < 60000,
        });
        saved.current = result;
        const next = { ...latest.current };
        if (next.secret === submitted.secret) next.secret = { value: "", clear: false };
        latest.current = next;
        if (mounted.current) {
          setData(result);
          setDraft(next);
        }
      }
    } catch (cause) {
      failed.current = true;
      conflicted.current = cause instanceof HttpError && cause.code === "conflict";
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
  const dirty = patchFor(draft, data) !== null;
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
    >
      <Card>
        <CardHeader>
          <CardTitle>{tr("统一登录")}</CardTitle>
          <CardDescription>
            {tr("通过支持 OIDC 的身份平台登录。保存后立即生效，密码登录仍可使用。")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldSet disabled={session.restore_mode}>
            <FieldGroup>
              <Field orientation="horizontal">
                <FieldLabel htmlFor="oidc-enabled">{tr("启用统一登录")}</FieldLabel>
                <Switch
                  id="oidc-enabled"
                  checked={draft.enabled}
                  onCheckedChange={(value) => update("enabled", value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="oidc-name">{tr("登录按钮名称")}</FieldLabel>
                <Input
                  id="oidc-name"
                  required
                  maxLength={80}
                  value={draft.display_name}
                  onChange={(event) => update("display_name", event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="oidc-issuer">Issuer URL</FieldLabel>
                <Input
                  id="oidc-issuer"
                  type="url"
                  required={draft.enabled}
                  maxLength={2048}
                  placeholder="https://identity.example.com"
                  value={draft.issuer_url}
                  onChange={(event) => update("issuer_url", event.target.value)}
                />
                <FieldDescription>
                  {tr("填写身份平台的 Issuer 地址，支持标准 OIDC Discovery。")}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="oidc-client">Client ID</FieldLabel>
                <Input
                  id="oidc-client"
                  required={draft.enabled}
                  maxLength={512}
                  autoComplete="off"
                  value={draft.client_id}
                  onChange={(event) => update("client_id", event.target.value)}
                />
              </Field>
              <Field>
                <div className="flex items-center justify-between gap-2">
                  <FieldLabel htmlFor="oidc-secret">Client Secret</FieldLabel>
                  <Badge variant={data.client_secret_configured ? "secondary" : "outline"}>
                    {data.client_secret_configured ? tr("已保存密钥") : tr("未配置")}
                  </Badge>
                </div>
                <Input
                  id="oidc-secret"
                  type="password"
                  maxLength={8192}
                  autoComplete="new-password"
                  disabled={draft.secret.clear}
                  placeholder={
                    data.client_secret_configured
                      ? tr("留空保留已保存的密钥")
                      : tr("输入 Client Secret")
                  }
                  value={draft.secret.value}
                  onChange={(event) =>
                    update("secret", { value: event.target.value, clear: false })
                  }
                />
                {data.client_secret_configured && (
                  <Button
                    type="button"
                    variant={draft.secret.clear ? "destructive" : "outline"}
                    size="sm"
                    onClick={() => update("secret", { value: "", clear: !draft.secret.clear })}
                  >
                    {draft.secret.clear ? tr("取消清除统一登录密钥") : tr("清除统一登录密钥")}
                  </Button>
                )}
                {draft.secret.clear && (
                  <FieldDescription>{tr("清除密钥前请关闭统一登录。")}</FieldDescription>
                )}
                {(draft.issuer_url.trim() !== data.issuer_url ||
                  draft.client_id.trim() !== data.client_id) &&
                  data.client_secret_configured && (
                    <FieldDescription>
                      {tr(
                        "更换身份平台或 Client ID 时，请同时输入新密钥，或关闭登录并清除旧密钥。",
                      )}
                    </FieldDescription>
                  )}
              </Field>
              <Field>
                <FieldLabel htmlFor="oidc-callback">{tr("回调地址")}</FieldLabel>
                <Input id="oidc-callback" value={data.redirect_uri} readOnly />
                <FieldDescription>
                  {tr("将此地址登记到身份平台。地址使用当前生效的站点 Base URL。")}
                </FieldDescription>
              </Field>
            </FieldGroup>
          </FieldSet>
        </CardContent>
        <CardFooter className="flex-col items-stretch gap-3">
          <ErrorBox message={error} />
          {error && !conflict && (
            <Button
              type="button"
              variant="outline"
              disabled={saving || session.restore_mode}
              onClick={() => {
                failed.current = false;
                void save();
              }}
            >
              {tr("重试自动保存")}
            </Button>
          )}
          <p
            role="status"
            aria-live="polite"
            data-testid="oidc-save-status"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            {saving && <Spinner />}
            {session.restore_mode
              ? tr("恢复模式下仅可查看配置")
              : error
                ? tr("自动保存失败，修改尚未保存")
                : saving
                  ? tr("正在自动保存…")
                  : invalid
                    ? tr("请填写有效配置；启用时必须提供客户端密钥。")
                    : dirty
                      ? tr("修改待保存…")
                      : tr("所有修改已保存")}
          </p>
        </CardFooter>
      </Card>
    </form>
  );
}
export function OIDCSettings() {
  const resource = useResource<Settings>("/admin/oidc");
  if (resource.loading) return <Loading />;
  if (resource.error) return <ErrorBox message={resource.error} retry={resource.refresh} />;
  return resource.data ? <OIDCSettingsForm initial={resource.data} /> : null;
}
