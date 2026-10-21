// @concord-file
// @concord-implements docs/feature/updates/use-case/check-updates.md
import { tr, interfaceLocale } from "@/lib/i18n";
import { RefreshCw, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { ErrorBox, Loading } from "@/components/shared";
import { useAction, useApp, useResource } from "@/lib/hooks";
import { write } from "@/lib/api";
import type { Schema } from "@/lib/types";

type Status = Schema["UpdateStatus"];
function stateLabel(data: Status) {
  if (data.status === "disabled") return tr("更新检查未启用");
  if (data.status === "unchecked") return tr("尚未检查");
  if (data.status === "error") return tr("检查失败，暂时无法确认最新版本");
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(data.current_version))
    return tr("开发版本，不参与版本比较");
  if (data.update_available) return tr("有新版本 {{v0}}", { v0: data.latest_version });
  if (data.current_version !== data.latest_version) return tr("当前版本高于已发布版本");
  return tr("已是最新版");
}
function safeLink(value: string | null) {
  if (!value) return undefined;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password ? value : undefined;
  } catch {
    return undefined;
  }
}
export function ServerUpdates() {
  const resource = useResource<Status>("/admin/updates");
  const action = useAction();
  const { session } = useApp();
  const data = resource.data;
  return (
    <Card className="my-6" data-testid="server-updates">
      <CardHeader>
        <CardTitle>{tr("版本与公告")}</CardTitle>
        <CardDescription>
          {tr("查看发布说明与升级通知，更新检查不会自动安装软件。")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        <ErrorBox message={resource.error || action.error} retry={resource.refresh} />
        {resource.loading && <Loading />}
        {data && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <span>
                {tr("当前版本：")}
                {data.current_version}
              </span>
              <Badge variant="outline">{stateLabel(data)}</Badge>
            </div>
            {data.latest_version && (
              <p>
                {tr("最近获取的正式版本：")}
                {data.latest_version}
              </p>
            )}
            {data.checked_at && (
              <p className="text-sm text-muted-foreground">
                {tr("最近检查：")}
                {new Date(data.checked_at).toLocaleString(interfaceLocale())}
              </p>
            )}
            {data.last_success_at && (
              <p className="text-sm text-muted-foreground">
                {tr("最后成功：")}
                {new Date(data.last_success_at).toLocaleString(interfaceLocale())}
              </p>
            )}
            {safeLink(data.release_url) && (
              <a
                className="inline-flex items-center gap-2 underline"
                href={safeLink(data.release_url)}
                target="_blank"
                rel="noopener noreferrer"
              >
                {tr("查看 GitHub 发布")} <ExternalLink aria-hidden="true" className="size-4" />
              </a>
            )}
            {data.release_notes && (
              <details>
                <summary className="cursor-pointer">{tr("版本更新日志")}</summary>
                <p className="mt-3 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                  {data.release_notes}
                </p>
              </details>
            )}
            {data.announcements.map((item) => (
              <article key={item.id} className="flex min-w-0 flex-col gap-2">
                <h3 className="flex flex-wrap items-center gap-2 font-medium">
                  {item.title}
                  <Badge variant={item.severity === "critical" ? "destructive" : "secondary"}>
                    {{ info: tr("公告"), warning: tr("注意"), critical: tr("重要") }[item.severity]}
                  </Badge>
                </h3>
                <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                  {item.body}
                </p>
                {safeLink(item.link) && (
                  <a
                    className="underline"
                    href={safeLink(item.link)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {tr("查看公告详情")}{" "}
                  </a>
                )}
              </article>
            ))}
          </>
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-3">
        <Button
          loading={action.busy}
          type="button"
          variant="outline"
          disabled={!data || data.status === "disabled" || action.busy || session.restore_mode}
          onClick={() =>
            void action.run(async () => {
              resource.setData(await write<Status>("/admin/updates", "POST", {}));
            })
          }
        >
          <RefreshCw data-icon="inline-start" />
          {action.busy ? tr("正在检查…") : tr("检查更新")}
        </Button>
        <p className="text-sm text-muted-foreground">
          {data?.status === "disabled"
            ? tr("管理员可通过部署配置 UPDATE_URL 启用。")
            : tr("每 24 小时自动检查；手动检查至少间隔 60 秒。")}
        </p>
      </CardFooter>
    </Card>
  );
}
