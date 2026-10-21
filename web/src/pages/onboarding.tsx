// @concord-file
// @concord-implements docs/feature/accounts/use-case/setup-site.md
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { tr } from "@/lib/i18n";
import { useApp, useResource } from "@/lib/hooks";
import { write, errorMessage } from "@/lib/api";
import type { Schema } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { ErrorBox, Loading, PageHeading } from "@/components/shared";
import { ServerSettingsForm } from "@/pages/server-settings";

function Onboarding({ onComplete, onLogout }: { onComplete: () => void; onLogout: () => void }) {
  const resource = useResource<Schema["ServerSettingsResponse"]>("/admin/server-settings");
  const { notify } = useApp();
  async function logout() {
    try { await write("/session", "DELETE"); onLogout(); }
    catch (error) { notify(errorMessage(error), true); }
  }
  return <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-10">
    <div className="flex items-start justify-between gap-4">
      <PageHeading title={tr("初始化站点")} />
      <Button variant="outline" onClick={() => void logout()}>{tr("退出登录")}</Button>
    </div>
    <p>{tr("管理员账号已创建。接下来配置并测试语言模型；中途离开后可以继续。")}</p>
    <p className="text-sm text-muted-foreground">{tr("数据库已连接。请确认站点配置；语音转写和 LLM 可分别配置，也可稍后在服务器设置中调整。")}</p>
    <ErrorBox message={resource.error} retry={resource.refresh} />
    {resource.loading ? <Loading /> : resource.data && <ServerSettingsForm data={resource.data} onboarding onComplete={onComplete} />}
  </main>;
}

export function SiteSetupGate({ children, onLogout }: { children: ReactNode; onLogout: () => void }) {
  const { session } = useApp();
  const location = useLocation();
  const status = useResource<{ site_setup_completed: boolean }>("/auth/status");
  if (session.restore_mode) return children;
  if (status.loading) return <Loading />;
  if (status.error) return <ErrorBox message={status.error} retry={status.refresh} />;
  if (!status.data) return <Loading />;
  if (!status.data.site_setup_completed) {
    if (session.user.role !== "admin") return <p>{tr("站点初始化尚未完成，请等待管理员完成配置")}</p>;
    if (location.pathname !== "/onboarding") return <Navigate to="/onboarding" replace />;
    return <Onboarding onComplete={status.refresh} onLogout={onLogout} />;
  }
  if (location.pathname === "/onboarding") return <Navigate to="/recordings" replace />;
  return children;
}
