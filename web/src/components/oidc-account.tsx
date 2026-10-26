// @concord-file
// @concord-implements docs/feature/accounts/use-case/oidc-login.md#link
import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { tr } from "@/lib/i18n";
import { oidcError, oidcLabel } from "@/lib/oidc";
import { write } from "@/lib/api";
import { useApp, useAction, useResource } from "@/lib/hooks";
import type { Schema } from "@/lib/types";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ErrorBox, Loading } from "@/components/shared";

export function OIDCAccount() {
  const { session, notify } = useApp();
  const resource = useResource<Schema["OIDCIdentity"]>("/me/oidc");
  const action = useAction();
  const location = useLocation();
  const navigate = useNavigate();
  const shown = useRef("");
  const params = new URLSearchParams(location.search);
  const feedback = oidcError(params.get("oidc_error"));
  useEffect(() => {
    if (shown.current === location.search) return;
    shown.current = location.search;
    const query = new URLSearchParams(location.search);
    if (feedback) notify(feedback, true);
    if (query.get("oidc_linked") === "1") {
      notify(tr("统一登录已绑定"));
      query.delete("oidc_linked");
      void navigate({ pathname: location.pathname, search: query.toString() }, { replace: true });
    }
  }, [location.search, location.pathname, feedback, navigate, notify]);
  if (resource.loading) return <Loading />;
  if (!resource.data) return <ErrorBox message={resource.error} retry={resource.refresh} />;
  const data = resource.data;
  if (!data.enabled && !data.linked && !feedback) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{tr("统一登录")}</CardTitle>
        <CardDescription>
          {data.linked
            ? tr("已绑定 {{name}}", { name: oidcLabel(data.display_name) })
            : tr("绑定后可使用 {{name}} 登录当前账号。", { name: oidcLabel(data.display_name) })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ErrorBox message={action.error || feedback} />
        {data.linked && (
          <p className="text-sm text-muted-foreground">
            {data.has_password
              ? tr("解绑后退出所有设备，可继续使用本地密码登录。")
              : tr("请先设置本地密码，再解绑统一登录。")}
          </p>
        )}
      </CardContent>
      <CardFooter>
        {data.linked ? (
          <Button
            variant="outline"
            loading={action.busy}
            disabled={action.busy || session.restore_mode || !data.has_password}
            onClick={() =>
              void action.run(async () => {
                await write("/me/oidc", "DELETE");
                window.dispatchEvent(new Event("voices:unauthorized"));
              })
            }
          >
            {tr("解绑并退出")}
          </Button>
        ) : (
          <Button
            variant="outline"
            loading={action.busy}
            disabled={action.busy || session.restore_mode || !data.enabled}
            onClick={() =>
              void action.run(async () => {
                const result = await write<Schema["OIDCStart"]>("/me/oidc", "POST", {});
                window.location.assign(result.authorization_url);
              })
            }
          >
            {tr("绑定 {{name}}", { name: oidcLabel(data.display_name) })}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
