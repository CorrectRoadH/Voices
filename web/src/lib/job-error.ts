// @concord-file
// @concord-implements docs/feature/transcription/use-case/transcribe.md
import { tr } from "./i18n";
import type { Job } from "./types";

export function jobError(job: Job): string {
  const reasons: Record<string, string> = {
    timeout: "等待服务商响应超时。",
    cancelled: "请求在完成前被中断。",
    dns: "无法解析服务商地址。",
    tls: "与服务商建立安全连接失败。",
    connection: "与服务商通信失败或连接中断。",
    response_read: "读取服务商响应失败。",
    response_too_large: "服务商响应超过允许的大小。",
    invalid_json: "服务商返回了无法解析的响应。",
    invalid_resource: "服务商响应未包含有效的资源 ID。",
    http_status: "服务商返回了异常 HTTP 状态。",
    local_persistence: "保存远端操作结果失败，受理状态需要核对。",
  };
  const codes: Record<string, string> = {
    auth: "服务商拒绝授权，请检查 API 密钥、权限和账户额度。",
    invalid: "请求参数或音频不符合要求，请检查转写设置。",
    rate_limited: "服务商请求频率受限，请稍后重试。",
    transient: "服务商暂时不可用。",
    unsupported: "服务商不支持当前转写选项。",
    not_found: "服务商未找到请求的资源。",
    transcription_failed: "服务商未能完成转写。",
    processing_failed: "音频处理失败，请查看系统日志。",
    restore_hold: "数据库恢复后的远端状态尚未核对。",
  };
  const reason = job.error_detail?.reason;
  const message =
    reason && reasons[reason]
      ? tr(reasons[reason])
      : tr(codes[job.error_code || ""] || "当时未记录详细原因，无法确定具体故障。");
  const status = job.error_detail?.http_status;
  return message + (status ? ` (HTTP ${status})` : "");
}
