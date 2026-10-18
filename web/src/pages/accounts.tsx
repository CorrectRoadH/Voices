// @concord-file
// @concord-implements docs/feature/accounts/use-case/manage-access.md
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { ErrorBox, Loading, PageHeading } from "@/components/shared";
import { useApp, useAction, useResource } from "@/lib/hooks";
import { write, query } from "@/lib/api";
import type { User, Page } from "@/lib/types";

function refreshSession() {
  window.dispatchEvent(new Event("voices:session-changed"));
}
export function AccountPage() {
  const { session } = useApp();
  const [name, setName] = useState(session.user.display_name);
  const [username, setUsername] = useState(session.user.username || "");
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const action = useAction();
  async function changePassword(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) return;
    await action.run(async () => {
      await write("/me/password", "PUT", { current_password: current, new_password: password });
      window.dispatchEvent(new Event("voices:unauthorized"));
    }, "密码已修改，请重新登录");
  }
  return (
    <>
      <PageHeading title="我的账号" />
      <ErrorBox message={action.error} />
      <div className="settings-grid">
        <Card>
          <CardHeader>
            <CardTitle>个人资料</CardTitle>
            <CardDescription>
              邮箱 {session.user.email} ·{" "}
              {session.user.role === "admin" ? "系统管理员" : "普通用户"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field><FieldLabel htmlFor="account-username">用户名</FieldLabel><Input id="account-username" autoComplete="username" value={username} maxLength={32} onChange={(event) => setUsername(event.target.value)} /><FieldDescription>可用于登录，2–32 个字母、数字或下划线；留空则使用邮箱登录。</FieldDescription></Field>
              <Field>
                <FieldLabel htmlFor="account-name">显示名称</FieldLabel>
                <Input
                  id="account-name"
                  value={name}
                  maxLength={100}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
            </FieldGroup>
          </CardContent>
          <CardFooter>
            <Button
              disabled={action.busy || session.restore_mode || !name.trim()}
              onClick={() =>
                void action.run(async () => {
                  await write("/me", "PATCH", { display_name: name, username });
                  refreshSession();
                }, "个人资料已保存")
              }
            >
              保存个人资料
            </Button>
          </CardFooter>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>修改密码</CardTitle>
            <CardDescription>修改后会退出所有设备，需要使用新密码登录。</CardDescription>
          </CardHeader>
          <CardContent>
            <form id="change-password" onSubmit={changePassword}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="current-password">当前密码</FieldLabel>
                  <Input
                    id="current-password"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={current}
                    onChange={(e) => setCurrent(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="new-password">新密码</FieldLabel>
                  <Input
                    id="new-password"
                    type="password"
                    autoComplete="new-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <FieldDescription>
                    至少 6 个字符，不要求复杂组合；不会自动去除空格。
                  </FieldDescription>
                </Field>
                <Field data-invalid={!!confirm && confirm !== password}>
                  <FieldLabel htmlFor="confirm-password">确认新密码</FieldLabel>
                  <Input
                    id="confirm-password"
                    type="password"
                    autoComplete="new-password"
                    required
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    aria-invalid={!!confirm && confirm !== password}
                  />
                  {confirm && confirm !== password && (
                    <FieldDescription>两次输入的密码不一致。</FieldDescription>
                  )}
                </Field>
              </FieldGroup>
            </form>
          </CardContent>
          <CardFooter>
            <Button
              type="submit"
              form="change-password"
              disabled={
                action.busy || session.restore_mode || !current || !password || password !== confirm
              }
            >
              修改密码并退出
            </Button>
          </CardFooter>
        </Card>
      </div>
    </>
  );
}
export function AdminAccountsPage() {
  const { session } = useApp();
  const [cursor, setCursor] = useState<string | null>(null);
  const users = useResource<Page<User>>("/admin/users" + query({ cursor }));
  const registration = useResource<{ registration_open: boolean }>("/admin/registration");
  const action = useAction();
  function update(user: User, patch: Partial<Pick<User, "role" | "status">>) {
    void action.run(async () => {
      await write(`/admin/users/${user.id}`, "PATCH", patch);
      users.refresh();
      if (user.id === session.user.id) refreshSession();
    }, "账号已更新");
  }
  return (
    <>
      <PageHeading
        title="账号管理"
      />
      <ErrorBox
        message={action.error || users.error || registration.error}
        retry={() => {
          users.refresh();
          registration.refresh();
        }}
      />
      <div className="flex flex-col gap-5">
        <Card>
          <CardHeader>
            <CardTitle>开放注册</CardTitle>
            <CardDescription>
              新账号默认为普通用户。所有已启用账号共用实例配置的转写服务额度。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field orientation="horizontal">
                <FieldLabel htmlFor="registration-open">允许创建新账号</FieldLabel>
                <Switch
                  id="registration-open"
                  checked={registration.data?.registration_open ?? false}
                  disabled={!registration.data || action.busy || session.restore_mode}
                  onCheckedChange={(open) => {
                    const previous = registration.data;
                    registration.setData({ registration_open: open });
                    void action
                      .run(async () => {
                        await write("/admin/registration", "PATCH", { registration_open: open });
                      }, "注册设置已保存")
                      .then((ok) => {
                        if (!ok) registration.setData(previous);
                      });
                  }}
                />
              </Field>
            </FieldGroup>
          </CardContent>
          <CardFooter>
            <p className="text-sm text-muted-foreground">关闭后已有账号仍可登录。</p>
          </CardFooter>
        </Card>
        {users.loading ? (
          <Loading />
        ) : (
          users.data?.items.map((user) => (
            <Card key={user.id}>
              <CardHeader>
                <CardTitle>{user.display_name}</CardTitle>
                <CardDescription>
                  {user.email}
                  {user.id === session.user.id ? " · 当前账号" : ""}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex gap-2">
                <Badge variant="secondary">{user.role === "admin" ? "管理员" : "普通用户"}</Badge>
                <Badge variant="outline">{user.status === "active" ? "已启用" : "已停用"}</Badge>
              </CardContent>
              <CardFooter className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={action.busy || session.restore_mode}
                  onClick={() => update(user, { role: user.role === "admin" ? "user" : "admin" })}
                >
                  {user.role === "admin" ? "设为普通用户" : "设为管理员"}
                </Button>
                <Button
                  variant="outline"
                  disabled={action.busy || session.restore_mode}
                  onClick={() =>
                    update(user, { status: user.status === "active" ? "disabled" : "active" })
                  }
                >
                  {user.status === "active" ? "停用账号" : "启用账号"}
                </Button>
              </CardFooter>
            </Card>
          ))
        )}
        <div className="flex gap-2">
          {cursor && (
            <Button variant="outline" onClick={() => setCursor(null)}>
              返回首页
            </Button>
          )}
          {users.data?.next_cursor && (
            <Button variant="outline" onClick={() => setCursor(users.data!.next_cursor)}>
              下一页
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
