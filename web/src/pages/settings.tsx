// @concord-file
// @concord-implements docs/feature/transcription/README.md
import { tr } from "@/lib/i18n";
import { useEffect, useState } from "react";
import { LockKeyhole, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { FieldGroup } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { OptionsFields, blankOptions, optionError } from "@/components/options";
import { ErrorBox, Loading, PageHeading } from "@/components/shared";
import { useAction, useResource, useApp } from "@/lib/hooks";
import { write } from "@/lib/api";
import type { Options, Settings, Provider, Page } from "@/lib/types";
export function SettingsPage() {
  const settings = useResource<Settings>("/settings");
  const providers = useResource<Page<Provider>>("/providers");
  const [options, setOptions] = useState<Options>(blankOptions);
  const action = useAction();
  const { session } = useApp();
  useEffect(() => {
    if (settings.data) {
      setOptions(settings.data.default_transcription || blankOptions);
    }
  }, [settings.data]);
  const invalid = optionError(options, providers.data?.items || []);
  return (
    <>
      <PageHeading
        title={tr("设置")}
      />
      {settings.loading || providers.loading ? (
        <Loading />
      ) : (
        <div className="settings-grid">
          <Card>
            <CardHeader>
              <CardTitle>{tr("转写偏好")}</CardTitle>
              <CardDescription>{tr("新设置只用于未来的导入，不改变已接受任务的选项快照。")}{" "}</CardDescription>
            </CardHeader>
            <CardContent>
              <ErrorBox
                message={settings.error || providers.error}
                retry={() => {
                  settings.refresh();
                  providers.refresh();
                }}
              />
              <FieldGroup>
                <OptionsFields value={options} onChange={setOptions} providers={providers.data?.items || []} />
                {invalid && <p className="text-sm text-destructive">{invalid}</p>}
              </FieldGroup>
            </CardContent>
            <CardFooter>
              <Button
                disabled={
                  action.busy ||
                  !!invalid ||
                  !settings.data ||
                  !!providers.error
                }
                onClick={() =>
                  void action.run(async () => {
                    await write("/settings", "PATCH", {
                      default_transcription: { ...options, diarization: true },
                      auto_transcribe: true,
                    });
                    settings.refresh();
                  }, tr("偏好设置已保存"))
                }
              >
                <Save data-icon="inline-start" />{tr("保存设置")}{" "}</Button>
            </CardFooter>
          </Card>
          <div className="flex flex-col gap-5">
            <Card>
              <CardHeader>
                <CardTitle>{tr("服务商连接")}</CardTitle>
                <CardDescription>{tr("密钥由管理员在服务器设置中管理，浏览器仅显示当前实例的配置状态。")}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {providers.data?.items.map((p) => (
                  <div key={p.id} className="flex items-center justify-between gap-2">
                    <span className="font-medium">{p.name}</span>
                    <Badge variant={p.configured ? "secondary" : "outline"}>
                      {p.configured ? tr("已配置") : tr("未配置")}
                    </Badge>
                  </div>
                ))}
              </CardContent>
              <CardFooter>
                <p className="text-xs text-muted-foreground">{tr("已配置表示存在服务端凭据，实际可用性由转写响应确认。")}{" "}</p>
              </CardFooter>
            </Card>
            {session.restore_mode && <Alert>
              <LockKeyhole />
              <AlertTitle>{tr("数据库恢复核对模式")}</AlertTitle>
              <AlertDescription>
                {session.restore_mode && tr("当前处于数据库恢复核对模式，历史任务需逐项核实。")}
              </AlertDescription>
            </Alert>}
          </div>
        </div>
      )}
    </>
  );
}
