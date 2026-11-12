// @concord-file
// @concord-implements docs/feature/accounts/README.md
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { notify } from "@/lib/notify";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarInset,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Spinner } from "@/components/ui/spinner";
import {
  tr,
  changeInterfaceLanguage,
  guestLanguage,
  normalizeLanguage,
  interfaceLocale,
} from "@/lib/i18n";
import { useTranslation } from "react-i18next";
import { GuestLanguageSelect } from "@/components/language-select";
import { useEffect, useLayoutEffect, useState, type FormEvent } from "react";
import {
  BrowserRouter,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  AudioLines,
  Library,
  Users,
  ListTodo,
  Settings,
  Server,
  LockKeyhole,
  ArrowRight,
  LogOut,
  ChevronsUpDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Toaster } from "@/components/ui/toast";
import { Separator } from "@/components/ui/separator";
import { ErrorBox, Loading, EmptyState } from "@/components/shared";
import { LibraryPage } from "@/pages/library";
import { DetailPage } from "@/pages/detail";
import { ReferencePage } from "@/pages/reference";
import { PeoplePage, PersonPage } from "@/pages/people";
import { CallLogs } from "@/components/call-logs";
import { AdminSTTCallsPage } from "@/pages/stt-pricing";
import { JobsPage } from "@/pages/jobs";
import { AccountPage, AdminAccountsPage } from "@/pages/accounts";
import { AdminOverviewPage, AdminLogsPage } from "@/pages/administration";
import { SiteSetupGate } from "@/pages/onboarding";
import { ServerSettingsPage } from "@/pages/server-settings";
import { SettingsPage } from "@/pages/settings";
import { request, write, configureSession, errorMessage, HttpError } from "@/lib/api";
import { basePath, safeReturnPath } from "@/lib/links";
import { SessionProvider } from "@/lib/hooks";
import { useResource } from "@/lib/hooks";
import type { Session, Schema } from "@/lib/types";
import { oidcError, oidcLabel } from "@/lib/oidc";
import { ThemeProvider } from "@/components/theme";
function Login({
  onLogin,
  error: initialError,
  retry,
}: {
  onLogin: (session: Session) => void;
  error: string;
  retry: () => void;
}) {
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [registering, setRegistering] = useState(false);
  const status = useResource<Schema["AuthStatus"]>("/auth/status");
  const first = status.data?.initialized === false;
  const register = first || registering;
  const [busy, setBusy] = useState(false);
  const [oidcBusy, setOIDCBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const credentialError = errorCode === "invalid_credentials";
  const emailError =
    credentialError || errorCode === "invalid_email" || errorCode === "email_taken";
  const passwordError = credentialError || errorCode === "invalid_password";
  const location = useLocation();
  const navigate = useNavigate();
  const callbackError = oidcError(new URLSearchParams(location.search).get("oidc_error"));
  useEffect(() => {
    if (callbackError) notify(callbackError, true);
  }, [callbackError]);
  async function loginOIDC() {
    if (busy || oidcBusy) return;
    setOIDCBusy(true);
    setError("");
    setErrorCode("");
    try {
      const result = await write<Schema["OIDCStart"]>("/auth/oidc/start", "POST", {});
      window.location.assign(result.authorization_url);
    } catch (cause) {
      const message = errorMessage(cause);
      setError(message);
      notify(message, true);
      setOIDCBusy(false);
    }
  }
  async function login(e: FormEvent) {
    e.preventDefault();
    if (busy || oidcBusy) return;
    setBusy(true);
    setError("");
    setErrorCode("");
    try {
      const session = await write<Session>(
        register ? "/users" : "/session",
        "POST",
        register
          ? {
              email,
              password,
              username: displayName,
              display_name: displayName,
              ui_language: interfaceLocale(),
            }
          : { identifier: email, password },
      );
      const base = basePath(import.meta.env.BASE_URL);
      const requested = new URLSearchParams(location.search).get("return_to");
      const current = `${base}${location.pathname}${location.search}${location.hash}`;
      const target = safeReturnPath(requested || current, base);
      configureSession(session);
      onLogin(session);
      setPassword("");
      navigate(target.slice(base.length) || "/recordings", { replace: true });
    } catch (e) {
      setErrorCode(e instanceof HttpError ? e.code : "");
      const message =
        e instanceof HttpError && e.status === 401
          ? tr("用户名、邮箱或密码不正确，请重试。")
          : errorMessage(e);
      setError(message);
      notify(message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 p-6">
      <div className="flex items-center gap-2">
        <AudioLines />
        <span className="font-medium">Voices</span>
      </div>
      <div className="w-full max-w-sm">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <LockKeyhole aria-hidden="true" />
            <CardTitle>
              {first ? tr("创建管理员账号") : register ? tr("注册账号") : tr("欢迎回来")}
            </CardTitle>
            {first && <CardDescription>{tr("首个注册账号将成为管理员。")}</CardDescription>}
          </CardHeader>
          <CardContent>
            <div className="mb-5">
              <GuestLanguageSelect />
            </div>
            <ErrorBox
              message={initialError || status.error || callbackError}
              retry={() => {
                retry();
                status.refresh();
              }}
            />
            <form id="login-form" onSubmit={login}>
              <FieldGroup>
                <Field data-invalid={emailError}>
                  <FieldLabel htmlFor="email">
                    {register ? tr("邮箱") : tr("用户名或邮箱")}
                  </FieldLabel>
                  <Input
                    id="email"
                    name={register ? "email" : "username"}
                    type={register ? "email" : "text"}
                    autoComplete={register ? "email" : "username"}
                    required
                    autoFocus
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    aria-invalid={emailError}
                  />
                </Field>
                {register && (
                  <Field>
                    <FieldLabel htmlFor="display-name">{tr("用户名")}</FieldLabel>
                    <Input
                      id="display-name"
                      required
                      maxLength={32}
                      autoComplete="username"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                    />
                  </Field>
                )}
                <Field data-invalid={passwordError}>
                  <FieldLabel htmlFor="password">{tr("密码")}</FieldLabel>
                  <Input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete={register ? "new-password" : "current-password"}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    aria-invalid={passwordError}
                  />
                  {register && (
                    <p className="text-sm text-muted-foreground">
                      {tr("至少 6 个字符，不要求字母、数字或符号组合。")}{" "}
                    </p>
                  )}
                  {error && (
                    <p className="text-sm text-destructive" role="alert">
                      {error}
                    </p>
                  )}
                </Field>
              </FieldGroup>
            </form>
          </CardContent>
          <CardContent className="flex flex-col gap-4">
            <Button
              aria-busy={busy}
              type="submit"
              form="login-form"
              disabled={
                busy ||
                oidcBusy ||
                !password ||
                !email ||
                status.loading ||
                !status.data ||
                (register && (!displayName || !status.data.registration_open))
              }
            >
              {busy && <Spinner data-icon="inline-start" aria-hidden="true" />}
              {busy ? tr("提交中…") : register ? tr("创建账号") : tr("进入工作台")}
              <ArrowRight data-icon="inline-end" />
            </Button>
            {status.data?.oidc_enabled && (
              <Button
                variant="outline"
                aria-busy={oidcBusy}
                disabled={busy || oidcBusy}
                onClick={() => void loginOIDC()}
              >
                {oidcBusy && <Spinner data-icon="inline-start" aria-hidden="true" />}
                {tr("使用 {{name}} 登录", { name: oidcLabel(status.data.oidc_display_name) })}
              </Button>
            )}
            {!first && status.data?.registration_open && (
              <Button
                variant="ghost"
                disabled={busy || oidcBusy}
                onClick={() => {
                  setRegistering(!registering);
                  setError("");
                  setErrorCode("");
                  setPassword("");
                }}
              >
                {registering ? tr("已有账号？登录") : tr("没有账号？注册")}
              </Button>
            )}
            {status.data && !status.data.registration_open && (
              <p className="text-sm text-muted-foreground">
                {status.data.initialized && !status.data.site_setup_completed
                  ? tr("站点初始化尚未完成，请等待管理员完成配置")
                  : tr("注册已关闭，请使用已有账号登录。")}
              </p>
            )}
            <p className="text-center text-xs text-muted-foreground">
              {tr("录音与句子引用都需要登录后访问。")}{" "}
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
function Shell({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const { setOpenMobile } = useSidebar();
  const location = useLocation();
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const nav = [
    { to: "/recordings", title: tr("录音库"), icon: Library },
    { to: "/people", title: tr("人物"), icon: Users },
    { to: "/jobs", title: tr("处理任务"), icon: ListTodo },
    { to: "/settings", title: tr("转写偏好"), icon: Settings },
  ];
  const adminGroups = [
    {
      title: tr("站点概览"),
      items: [{ to: "/admin/overview", title: tr("站点概览"), icon: Server }],
    },
    {
      title: tr("用量与费用"),
      items: [{ to: "/admin/stt/calls", title: tr("STT 调用"), icon: ListTodo }],
    },
    {
      title: tr("运行诊断"),
      items: [
        { to: "/admin/calls", title: tr("调用日志"), icon: ListTodo },
        { to: "/admin/logs", title: tr("系统日志"), icon: ListTodo },
      ],
    },
    {
      title: tr("管理"),
      items: [
        { to: "/admin/accounts", title: tr("账号管理"), icon: Users },
        { to: "/admin/server", title: tr("服务器设置"), icon: Server },
      ],
    },
  ];
  const menu = (items: typeof nav) => (
    <SidebarMenu>
      {items.map(({ to, title, icon: Icon }) => (
        <SidebarMenuItem key={to}>
          <SidebarMenuButton
            isActive={location.pathname === to || location.pathname.startsWith(`${to}/`)}
            render={<NavLink to={to} onClick={() => setOpenMobile(false)} />}
          >
            <Icon />
            <span>{title}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
  return (
    <>
      <Sidebar>
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                render={
                  <NavLink
                    to="/recordings"
                    aria-label={tr("Voices 首页")}
                    onClick={() => setOpenMobile(false)}
                  />
                }
              >
                <AudioLines />
                <span>Voices</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <nav aria-label={tr("主导航")}>{menu(nav)}</nav>
            </SidebarGroupContent>
          </SidebarGroup>
          {session.user.role === "admin" &&
            adminGroups.map((group, index) => (
              <SidebarGroup key={group.title}>
                {index > 0 && <SidebarGroupLabel>{group.title}</SidebarGroupLabel>}
                <SidebarGroupContent>
                  <nav aria-label={group.title}>{menu(group.items)}</nav>
                </SidebarGroupContent>
              </SidebarGroup>
            ))}
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <SidebarMenuButton
                      size="lg"
                      aria-label={tr("我的账号")}
                      disabled={logoutBusy}
                      aria-busy={logoutBusy}
                    />
                  }
                >
                  <Avatar>
                    <AvatarFallback>{Array.from(session.user.display_name)[0]}</AvatarFallback>
                  </Avatar>
                  <span className="grid min-w-0 flex-1 gap-1 text-left">
                    <span className="truncate">{session.user.display_name}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {session.user.email}
                    </span>
                  </span>
                  {logoutBusy ? <Spinner aria-hidden="true" /> : <ChevronsUpDown />}
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="end" className="min-w-56">
                  <DropdownMenuGroup>
                    <DropdownMenuItem
                      render={<NavLink to="/account" onClick={() => setOpenMobile(false)} />}
                    >
                      <Users />
                      {tr("我的账号")}
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuItem
                      disabled={logoutBusy}
                      onClick={async () => {
                        setLogoutBusy(true);
                        try {
                          await write("/session", "DELETE");
                          onLogout();
                        } catch (e) {
                          setLogoutError(errorMessage(e));
                          notify(errorMessage(e), true);
                        } finally {
                          setLogoutBusy(false);
                        }
                      }}
                    >
                      <LogOut />
                      {tr("退出登录")}
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger aria-label={tr("切换导航")} />
          <Separator orientation="vertical" className="h-4" />
          <span className="text-sm">Voices</span>
        </header>
        <div className="main-content w-full min-w-0 p-4 md:p-6">
          <ErrorBox message={logoutError} />
          {session.restore_mode && (
            <Alert className="mb-5">
              <AlertTitle>{tr("数据库恢复核对模式")}</AlertTitle>
              <AlertDescription>
                {tr("历史任务已隔离，请在任务页核实远端受理情况。不会自动重新提交付费任务。")}{" "}
              </AlertDescription>
            </Alert>
          )}
          <Routes>
            <Route path="/" element={<Navigate to="/recordings" replace />} />
            <Route path="/login" element={<Navigate to="/recordings" replace />} />
            <Route path="/recordings" element={<LibraryPage />} />
            <Route path="/q/:code" element={<ReferencePage />} />
            <Route path="/recordings/:recordingId" element={<DetailPage key="recording" />} />
            <Route
              path="/recordings/:recordingId/transcriptions/:transcriptionId"
              element={<DetailPage key="transcription" />}
            />
            <Route path="/people" element={<PeoplePage />} />
            <Route path="/people/:personId" element={<PersonPage />} />
            <Route path="/jobs" element={<JobsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/account" element={<AccountPage />} />
            <Route
              path="/admin/overview"
              element={
                session.user.role === "admin" ? (
                  <AdminOverviewPage />
                ) : (
                  <Navigate to="/recordings" replace />
                )
              }
            />
            <Route
              path="/admin/stt/calls"
              element={
                session.user.role === "admin" ? (
                  <AdminSTTCallsPage />
                ) : (
                  <Navigate to="/recordings" replace />
                )
              }
            />
            <Route
              path="/admin/stt/prices"
              element={
                session.user.role === "admin" ? (
                  <Navigate to="/admin/stt/calls" replace />
                ) : (
                  <Navigate to="/recordings" replace />
                )
              }
            />
            <Route
              path="/admin/calls"
              element={
                session.user.role === "admin" ? (
                  <CallLogs admin />
                ) : (
                  <Navigate to="/recordings" replace />
                )
              }
            />
            <Route
              path="/admin/logs"
              element={
                session.user.role === "admin" ? (
                  <AdminLogsPage />
                ) : (
                  <Navigate to="/recordings" replace />
                )
              }
            />
            <Route
              path="/admin/server"
              element={
                session.user.role === "admin" ? (
                  <ServerSettingsPage />
                ) : (
                  <Navigate to="/recordings" replace />
                )
              }
            />
            <Route
              path="/admin/accounts"
              element={
                session.user.role === "admin" ? (
                  <AdminAccountsPage />
                ) : (
                  <Navigate to="/recordings" replace />
                )
              }
            />
            <Route
              path="*"
              element={
                <EmptyState title={tr("页面不存在")} description={tr("请从左侧导航返回工作台。")} />
              }
            />
          </Routes>
        </div>
      </SidebarInset>
    </>
  );
}
function AppContent() {
  const [session, setSession] = useState<Session | null>(null);
  useLayoutEffect(() => {
    changeInterfaceLanguage(
      session ? normalizeLanguage(session.user.ui_language) : guestLanguage(),
    );
  }, [session?.user.id, session?.user.ui_language]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    request<Session>("/session", { signal: controller.signal })
      .then((s) => {
        if (controller.signal.aborted) return;
        if (!s.authenticated) {
          setSession(null);
          return;
        }
        configureSession(s);
        setSession(s);
        setError("");
      })
      .catch((e) => {
        if (!controller.signal.aborted && e instanceof HttpError && e.status === 401)
          setSession(null);
        if (!controller.signal.aborted && !(e instanceof HttpError && e.status === 401))
          setError(errorMessage(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [attempt]);
  useEffect(() => {
    const expire = () => {
      setSession(null);
    };
    const refresh = () => setAttempt((n) => n + 1);
    window.addEventListener("voices:unauthorized", expire);
    window.addEventListener("voices:session-changed", refresh);
    return () => {
      window.removeEventListener("voices:unauthorized", expire);
      window.removeEventListener("voices:session-changed", refresh);
    };
  }, []);
  if (loading && !session)
    return (
      <div className="mx-auto mt-24 max-w-lg px-6">
        <Loading />
      </div>
    );
  if (!session)
    return <Login onLogin={setSession} error={error} retry={() => setAttempt((n) => n + 1)} />;
  return (
    <SessionProvider
      session={session}
      notify={notify}
      updateUser={(user) =>
        setSession((current) => (current?.user.id === user.id ? { ...current, user } : current))
      }
    >
      <SiteSetupGate onLogout={() => setSession(null)}>
        <SidebarProvider>
          <Shell session={session} onLogout={() => setSession(null)} />
        </SidebarProvider>
      </SiteSetupGate>
    </SessionProvider>
  );
}
export default function App() {
  useTranslation();
  return (
    <ThemeProvider>
      <BrowserRouter basename={basePath(import.meta.env.BASE_URL) || "/"}>
        <TooltipProvider>
          <Toaster>
            <AppContent />
          </Toaster>
        </TooltipProvider>
      </BrowserRouter>
    </ThemeProvider>
  );
}
