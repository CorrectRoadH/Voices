// @concord-file
// @concord-implements docs/feature/accounts/use-case/manage-access.md
import { tr } from "@/lib/i18n";
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
import { ThemeSelect } from "@/components/theme";
import { AccountLanguageSelect } from "@/components/language-select";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorBox, Loading, PageHeading } from "@/components/shared";
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
    }, tr("密码已修改，请重新登录"));
  }
  return (
    <>
      <PageHeading title={tr("我的账号")} />
      <ErrorBox message={action.error} />
      <div className="settings-grid">
        <Card>
          <CardHeader>
            <CardTitle>{tr("外观设置")}</CardTitle>
            <CardDescription>{tr("选择适合你的界面主题，即时生效。")}</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="account-theme">{tr("界面主题")}</FieldLabel>
                <ThemeSelect id="account-theme" />
                <FieldDescription>
                  {tr("仅保存在当前浏览器；选择“跟随系统”可自动切换浅色与深色。")}
                </FieldDescription>
              </Field>
              <AccountLanguageSelect />
            </FieldGroup>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{tr("个人资料")}</CardTitle>
            <CardDescription>
              {tr("邮箱")} {session.user.email} ·{" "}
              {session.user.role === "admin" ? tr("系统管理员") : tr("普通用户")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="account-username">{tr("用户名")}</FieldLabel>
                <Input
                  id="account-username"
                  autoComplete="username"
                  value={username}
                  maxLength={32}
                  onChange={(event) => setUsername(event.target.value)}
                />
                <FieldDescription>
                  {tr("可用于登录，2–32 个字母、数字或下划线；留空则使用邮箱登录。")}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="account-name">{tr("显示名称")}</FieldLabel>
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
                }, tr("个人资料已保存"))
              }
            >
              {tr("保存个人资料")}{" "}
            </Button>
          </CardFooter>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{tr("修改密码")}</CardTitle>
            <CardDescription>{tr("修改后会退出所有设备，需要使用新密码登录。")}</CardDescription>
          </CardHeader>
          <CardContent>
            <form id="change-password" onSubmit={changePassword}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="current-password">{tr("当前密码")}</FieldLabel>
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
                  <FieldLabel htmlFor="new-password">{tr("新密码")}</FieldLabel>
                  <Input
                    id="new-password"
                    type="password"
                    autoComplete="new-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <FieldDescription>
                    {tr("至少 6 个字符，不要求复杂组合；不会自动去除空格。")}{" "}
                  </FieldDescription>
                </Field>
                <Field data-invalid={!!confirm && confirm !== password}>
                  <FieldLabel htmlFor="confirm-password">{tr("确认新密码")}</FieldLabel>
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
                    <FieldDescription>{tr("两次输入的密码不一致。")}</FieldDescription>
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
              {tr("修改密码并退出")}{" "}
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
  const [filters, setFilters] = useState({ q: "", status: "", role: "" });
  const users = useResource<Page<User>>("/admin/users" + query({ cursor, ...filters }));
  const registration = useResource<{ registration_open: boolean }>("/admin/registration");
  const action = useAction();
  function update(user: User, patch: Partial<Pick<User, "role" | "status">>) {
    void action.run(async () => {
      await write(`/admin/users/${user.id}`, "PATCH", patch);
      users.refresh();
      if (user.id === session.user.id) refreshSession();
    }, tr("账号已更新"));
  }
  return (
    <>
      <PageHeading title={tr("账号管理")} />
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
            <CardTitle>{tr("开放注册")}</CardTitle>
            <CardDescription>
              {tr("新账号默认为普通用户。所有已启用账号共用实例配置的转写服务额度。")}{" "}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field orientation="horizontal">
                <FieldLabel htmlFor="registration-open">{tr("允许创建新账号")}</FieldLabel>
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
                      }, tr("注册设置已保存"))
                      .then((ok) => {
                        if (!ok) registration.setData(previous);
                      });
                  }}
                />
              </Field>
            </FieldGroup>
          </CardContent>
          <CardFooter>
            <p className="text-sm text-muted-foreground">{tr("关闭后已有账号仍可登录。")}</p>
          </CardFooter>
        </Card>
        <AccountFilters
          onApply={(next) => {
            setFilters(next);
            setCursor(null);
          }}
        />
        {!users.loading && !users.error && users.data?.items.length === 0 && (
          <EmptyState title={tr("没有匹配的账号")} description={tr("试试其他关键词或筛选条件。")} />
        )}
        {users.loading ? (
          <Loading />
        ) : (
          !users.error &&
          users.data?.items.map((user) => (
            <Card key={user.id}>
              <CardHeader>
                <CardTitle>{user.display_name}</CardTitle>
                <CardDescription>
                  {user.email}
                  {user.id === session.user.id ? tr(" · 当前账号") : ""}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex gap-2">
                <Badge variant="secondary">
                  {user.role === "admin" ? tr("管理员") : tr("普通用户")}
                </Badge>
                <Badge variant="outline">
                  {user.status === "active" ? tr("已启用") : tr("已停用")}
                </Badge>
              </CardContent>
              <CardFooter className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={action.busy || session.restore_mode}
                  onClick={() => update(user, { role: user.role === "admin" ? "user" : "admin" })}
                >
                  {user.role === "admin" ? tr("设为普通用户") : tr("设为管理员")}
                </Button>
                <Button
                  variant="outline"
                  disabled={action.busy || session.restore_mode}
                  onClick={() =>
                    update(user, { status: user.status === "active" ? "disabled" : "active" })
                  }
                >
                  {user.status === "active" ? tr("停用账号") : tr("启用账号")}
                </Button>
              </CardFooter>
            </Card>
          ))
        )}
        <div className="flex gap-2">
          {cursor && (
            <Button variant="outline" onClick={() => setCursor(null)}>
              {tr("返回首页")}{" "}
            </Button>
          )}
          {users.data?.next_cursor && (
            <Button variant="outline" onClick={() => setCursor(users.data!.next_cursor)}>
              {tr("下一页")}{" "}
            </Button>
          )}
        </div>
      </div>
    </>
  );
}

function AccountFilters({
  onApply,
}: {
  onApply: (filters: { q: string; status: string; role: string }) => void;
}) {
  const [q, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [role, setRole] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onApply({ q: q.trim(), status, role });
      }}
    >
      <FieldGroup className="grid items-end gap-4 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_9rem_9rem_auto]">
        <Field>
          <FieldLabel htmlFor="account-search">{tr("搜索账号")}</FieldLabel>
          <Input
            id="account-search"
            type="search"
            placeholder={tr("邮箱、用户名或显示名称")}
            maxLength={100}
            value={q}
            onChange={(event) => setQuery(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="account-status">{tr("账号状态")}</FieldLabel>
          <NativeSelect
            id="account-status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className="w-full"
          >
            <NativeSelectOption value="">{tr("全部状态")}</NativeSelectOption>
            <NativeSelectOption value="active">{tr("已启用")}</NativeSelectOption>
            <NativeSelectOption value="disabled">{tr("已停用")}</NativeSelectOption>
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor="account-role">{tr("账号角色")}</FieldLabel>
          <NativeSelect
            id="account-role"
            value={role}
            onChange={(event) => setRole(event.target.value)}
            className="w-full"
          >
            <NativeSelectOption value="">{tr("全部角色")}</NativeSelectOption>
            <NativeSelectOption value="admin">{tr("管理员")}</NativeSelectOption>
            <NativeSelectOption value="user">{tr("普通用户")}</NativeSelectOption>
          </NativeSelect>
        </Field>
        <Button type="submit" variant="outline">
          {tr("筛选账号")}
        </Button>
      </FieldGroup>
    </form>
  );
}
