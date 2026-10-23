// @concord-file
// @concord-implements docs/feature/accounts/README.md
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { toast, Toaster } from "@/components/ui/toast";
import { Separator } from "@/components/ui/separator";
import { ErrorBox, Loading, EmptyState } from "@/components/shared";
import { LibraryPage } from "@/pages/library";
import { DetailPage } from "@/pages/detail";
import { ReferencePage } from "@/pages/reference";
import { PeoplePage, PersonPage } from "@/pages/people";
import { CallLogs } from "@/components/call-logs";
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
import type { Session } from "@/lib/types";
import { cn } from "@/lib/utils";
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
  const status = useResource<{
    initialized: boolean;
    registration_open: boolean;
    site_setup_completed: boolean;
  }>("/auth/status");
  const first = status.data?.initialized === false;
  const register = first || registering;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const credentialError = errorCode === "invalid_credentials";
  const emailError =
    credentialError || errorCode === "invalid_email" || errorCode === "email_taken";
  const passwordError = credentialError || errorCode === "invalid_password";
  const location = useLocation();
  const navigate = useNavigate();
  async function login(e: FormEvent) {
    e.preventDefault();
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
    <main className="login-page">
      <div className="login-story">
        <div className="brand">
          <span className="brand-mark">
            <AudioLines />
          </span>
          <span>
            Voices<span className="brand-dot">.</span>
          </span>
        </div>
      </div>
      <div className="login-form">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <span className="login-lock">
              <LockKeyhole />
            </span>
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
              message={initialError || status.error}
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
          <CardFooter className="flex-col items-stretch gap-4">
            <Button
              loading={busy}
              type="submit"
              form="login-form"
              disabled={
                busy ||
                !password ||
                !email ||
                status.loading ||
                !status.data ||
                (register && (!displayName || !status.data.registration_open))
              }
            >
              {busy ? tr("提交中…") : register ? tr("创建账号") : tr("进入工作台")}
              <ArrowRight data-icon="inline-end" />
            </Button>
            {!first && status.data?.registration_open && (
              <Button
                variant="ghost"
                disabled={busy}
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
          </CardFooter>
        </Card>
      </div>
    </main>
  );
}
function Shell({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const nav = [
    { to: "/recordings", title: tr("录音库"), icon: Library },
    { to: "/people", title: tr("人物"), icon: Users },
    { to: "/jobs", title: tr("处理任务"), icon: ListTodo },
    { to: "/settings", title: tr("转写偏好"), icon: Settings },
  ];
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <NavLink to="/recordings" className="brand" aria-label={tr("Voices 首页")}>
          <span className="brand-mark">
            <AudioLines />
          </span>
          <span>
            Voices<span className="brand-dot">.</span>
          </span>
        </NavLink>
        <nav aria-label={tr("主导航")}>
          {nav.map(({ to, title, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => cn("nav-item", isActive && "nav-active")}
            >
              <Icon />
              <span>{title}</span>
            </NavLink>
          ))}
        </nav>
        {session.user.role === "admin" && (
          <nav aria-label={tr("服务器管理")} className="admin-nav max-md:flex-wrap">
            <p className="nav-group-label">{tr("服务器管理")}</p>
            <NavLink
              to="/admin/overview"
              className={({ isActive }) => cn("nav-item", isActive && "nav-active")}
            >
              <Server />
              <span>{tr("站点概览")}</span>
            </NavLink>
            <NavLink
              to="/admin/calls"
              className={({ isActive }) => cn("nav-item", isActive && "nav-active")}
            >
              <ListTodo />
              <span>{tr("调用日志")}</span>
            </NavLink>
            <NavLink
              to="/admin/logs"
              className={({ isActive }) => cn("nav-item", isActive && "nav-active")}
            >
              <ListTodo />
              <span>{tr("系统日志")}</span>
            </NavLink>
            <NavLink
              to="/admin/accounts"
              className={({ isActive }) => cn("nav-item", isActive && "nav-active")}
            >
              <Users />
              <span>{tr("账号管理")}</span>
            </NavLink>
            <NavLink
              to="/admin/server"
              className={({ isActive }) => cn("nav-item", isActive && "nav-active")}
            >
              <Server />
              <span>{tr("服务器设置")}</span>
            </NavLink>
          </nav>
        )}
        <div className="sidebar-bottom">
          <Separator />
          <div className="account-row">
            <NavLink
              to="/account"
              aria-label={tr("我的账号")}
              className={({ isActive }) => cn("account-profile", isActive && "nav-active")}
            >
              <span className="account-avatar">{Array.from(session.user.display_name)[0]}</span>
              <span className="account-identity">
                <span className="truncate">{session.user.display_name}</span>
                <small className="truncate">{session.user.email}</small>
              </span>
            </NavLink>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={tr("退出登录")}
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
            </Button>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <main className="main-content">
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
        </main>
      </div>
    </div>
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
        <Shell session={session} onLogout={() => setSession(null)} />
      </SiteSetupGate>
    </SessionProvider>
  );
}
function notify(text: string, isError = false) {
  toast.add({
    title: isError ? tr("操作未完成") : tr("已完成"),
    description: text,
    type: isError ? "error" : "success",
    priority: isError ? "high" : "low",
    timeout: isError ? 0 : 4500,
  });
}

export default function App() {
  useTranslation();
  return (
    <ThemeProvider>
      <BrowserRouter basename={basePath(import.meta.env.BASE_URL) || "/"}>
        <Toaster>
          <AppContent />
        </Toaster>
      </BrowserRouter>
    </ThemeProvider>
  );
}
