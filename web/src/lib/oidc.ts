// @concord-file
// @concord-implements docs/feature/accounts/use-case/oidc-login.md#login
import { tr } from "@/lib/i18n";

export function oidcError(code: string | null): string {
  if (!code) return "";
  switch (code) {
    case "account_exists":
      return tr("该邮箱已有账号。请先用原方式登录，再到我的账号绑定统一登录。");
    case "registration_closed":
      return tr("站点已关闭注册，请联系管理员；已绑定的账号仍可登录。");
    case "verified_email_required":
      return tr("身份平台未提供已验证的邮箱，无法创建账号。请先验证邮箱或登录已有账号进行绑定。");
    case "identity_taken":
      return tr("该身份已被绑定，或当前账号已有不同的统一身份。");
    case "account_disabled":
      return tr("账号已被停用，请联系管理员。");
    case "session_expired":
      return tr("原登录会话已失效，请重新登录后再绑定。");
    case "configuration_changed":
      return tr("统一登录配置已变化，请重新开始登录。");
    case "cancelled":
      return tr("已取消统一登录，可以重新尝试或使用密码登录。");
    case "restore_mode":
      return tr("恢复模式下不能创建账号或修改统一登录绑定。");
    case "unavailable":
      return tr("身份平台暂时不可用，请稍后重试或使用密码登录。");
    default:
      return tr("统一登录验证失败或已过期，请重新开始登录。");
  }
}
export function oidcLabel(name: string): string {
  return name === "统一登录" ? tr("统一登录") : name;
}
