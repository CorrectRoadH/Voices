import { tr, interfaceLocale } from "@/lib/i18n";
export function duration(ms: number | null) {
  if (ms === null) return tr("无时间");
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}
export function date(value: string) {
  return new Date(value).toLocaleString(interfaceLocale(), {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
export function bytes(value: number) {
  return value >= 1024 ** 3
    ? `${(value / 1024 ** 3).toFixed(1)} GB`
    : `${(value / 1024 ** 2).toFixed(1)} MB`;
}
export const states: Record<string, string> = {
  preparing: "预处理中",
  ready: "音频已就绪",
  deleting: "待清理",
  queued: "排队中",
  running: "处理中",
  retry_wait: "等待重试",
  uncertain: "结果待确认",
  restore_hold: "恢复待核对",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  uploading: "上传服务商",
  submitting: "提交转写",
  polling: "等待服务商结果",
  normalizing: "整理结果",
  pending: "等待处理",
  prepared: "尚未发送",
  sent: "已发送待确认",
  known: "已有远端 ID",
  confirmed_absent: "确认未创建",
};
export function stateName(value: string) {
  return states[value] ? tr(states[value]) : value;
}

export function localDateValue(value: string | null) {
  if (!value) return "";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "";
  return new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
