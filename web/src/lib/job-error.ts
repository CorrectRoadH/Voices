// @concord-file
// @concord-implements docs/feature/transcription/use-case/recover-task.md#inspect
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
    direct_request_interrupted: "直接转写已中断，不能重试；请新建版本，可能再次收费。",
    direct_auth: "服务商拒绝授权，请检查 OpenAI STT 密钥、权限和账户额度。",
    direct_invalid: "请求参数或音频不符合 OpenAI 要求。",
    direct_unsupported: "OpenAI 不支持当前转写选项。",
    direct_not_found: "OpenAI 转写接口不可用，请检查 STT 地址。",
    direct_rate_limited: "OpenAI 请求频率受限；本任务不会自动重发。",
    direct_uncertain: "直接请求受理结果不明；本任务不会自动重发。",
    direct_invalid_result: "OpenAI 返回的说话人或时间戳无效。",
    direct_invalid_file_size: "OpenAI 音频文件须大于 0 且不超过 25 MB。",
    direct_unsupported_format: "OpenAI 不支持此音频文件格式。",
    direct_result_persistence_failed: "直接转写结果保存失败；请新建版本，可能再次收费。",
    direct_request_failed: "直接转写失败；本任务不会自动重发。",
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
