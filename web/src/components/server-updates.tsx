// @concord-file
// @concord-implements docs/feature/updates/use-case/check-updates.md
import { Spinner } from "@/components/ui/spinner";
import { InformationDialog } from "./information-dialog";
import { Markdown, safeReleaseLink } from "./markdown";
import { notify } from "@/lib/notify";
import {
  Item,
  ItemGroup,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from "@/components/ui/item";
import { tr, interfaceLocale } from "@/lib/i18n";
import { RefreshCw, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

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
export function ServerUpdates() {
  const resource = useResource<Status>("/admin/updates");
  const action = useAction();
  const { session } = useApp();
  const data = resource.data;
  return (
    <section className="mb-6 flex min-w-0 flex-col gap-3" data-testid="server-updates">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-medium">{tr("版本与公告")}</h2>
        <div className="flex flex-wrap items-center gap-2">
          {data?.release_notes && (
            <InformationDialog
              title={tr("版本更新日志")}
              description={`${tr("最近获取的正式版本：")}${data.latest_version || ""}`}
            >
              <Markdown>{data.release_notes}</Markdown>
              {safeReleaseLink(data.release_url) && (
                <Button
                  variant="link"
                  nativeButton={false}
                  render={
                    <a
                      href={safeReleaseLink(data.release_url)}
                      target="_blank"
                      rel="noopener noreferrer"
                    />
                  }
                >
                  {tr("查看 GitHub 发布")}
                  <ExternalLink data-icon="inline-end" />
                </Button>
              )}
            </InformationDialog>
          )}
          <Button
            aria-busy={action.busy}
            type="button"
            variant="outline"
            size="sm"
            disabled={!data || data.status === "disabled" || action.busy || session.restore_mode}
            onClick={() =>
              void action.run(async () => {
                const result = await write<Status>("/admin/updates", "POST", {});
                resource.setData(result);
                notify(stateLabel(result), result.status === "error");
              })
            }
          >
            {action.busy ? (
              <Spinner data-icon="inline-start" aria-hidden="true" />
            ) : (
              <RefreshCw data-icon="inline-start" />
            )}
            {action.busy ? tr("正在检查…") : tr("检查更新")}
          </Button>
        </div>
      </div>
      <ErrorBox message={resource.error || action.error} retry={resource.refresh} />
      {resource.loading && <Loading compact />}
      {data && (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <span>
              {tr("当前版本：")}
              {data.current_version}
            </span>
            {data.latest_version && (
              <span>
                {tr("最近获取的正式版本：")}
                {data.latest_version}
              </span>
            )}
            <Badge variant="outline">{stateLabel(data)}</Badge>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {data.checked_at && (
              <span>
                {tr("最近检查：")}
                {new Date(data.checked_at).toLocaleString(interfaceLocale())}
              </span>
            )}
            {data.last_success_at && data.last_success_at !== data.checked_at && (
              <span>
                {tr("最后成功：")}
                {new Date(data.last_success_at).toLocaleString(interfaceLocale())}
              </span>
            )}
            <span>
              {data.status === "disabled"
                ? tr("管理员可通过部署配置 UPDATE_URL 启用。")
                : tr("每 24 小时自动检查；手动检查至少间隔 60 秒。")}
            </span>
          </div>
          {data.announcements.length > 0 && (
            <ItemGroup>
              {data.announcements.map((item) => (
                <Item key={item.id} variant="outline">
                  <ItemContent>
                    <ItemTitle>
                      {item.title}
                      <Badge variant={item.severity === "critical" ? "destructive" : "secondary"}>
                        {
                          { info: tr("公告"), warning: tr("注意"), critical: tr("重要") }[
                            item.severity
                          ]
                        }
                      </Badge>
                    </ItemTitle>
                    <ItemDescription>{item.body.split(/\n\s*\n/)[0].slice(0, 180)}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <InformationDialog
                      title={item.title}
                      label={tr("查看公告详情")}
                      description={tr("公告")}
                    >
                      <Markdown>{item.body}</Markdown>
                      {safeReleaseLink(item.link) && (
                        <Button
                          variant="link"
                          nativeButton={false}
                          render={
                            <a
                              href={safeReleaseLink(item.link)}
                              target="_blank"
                              rel="noopener noreferrer"
                            />
                          }
                        >
                          {tr("查看原文")}
                          <ExternalLink data-icon="inline-end" />
                        </Button>
                      )}
                    </InformationDialog>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          )}
        </>
      )}
    </section>
  );
}
