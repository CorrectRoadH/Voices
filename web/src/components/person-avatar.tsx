// @concord-file
// @concord-implements docs/feature/people/use-case/link-person.md
import { tr } from "@/lib/i18n";
import { builtinPersonName } from "@/lib/person-name";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { apiUrl } from "@/lib/api";
import type { Person } from "@/lib/types";
export function PersonAvatar({
  id,
  name,
  person,
  preview,
}: {
  id: string;
  name: string;
  person?: Person;
  preview?: string | null;
}) {
  const tone = Array.from(id).reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0) % 6;
  const src =
    preview === undefined
      ? person?.has_avatar
        ? apiUrl(`/people/${id}/avatar?v=${person.avatar_revision}`)
        : undefined
      : preview || undefined;
  return (
    <Avatar className={`person-photo person-photo-${tone}`}>
      {src && <AvatarImage src={src} alt="" />}
      <AvatarFallback>
        {Array.from(builtinPersonName(person?.builtin_key, name).trim())[0] || "?"}
      </AvatarFallback>
    </Avatar>
  );
}
export async function prepareAvatar(file: File): Promise<string> {
  if (file.size > 10 * 1024 * 1024) throw new Error(tr("请选择 10 MB 以内的图片。"));
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(tr("无法读取图片，请选择 PNG、JPEG 或 WebP 图片。"));
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(tr("浏览器无法处理图片。"));
    const size = Math.min(bitmap.width, bitmap.height);
    context.drawImage(
      bitmap,
      (bitmap.width - size) / 2,
      (bitmap.height - size) / 2,
      size,
      size,
      0,
      0,
      256,
      256,
    );
    return canvas.toDataURL("image/png");
  } finally {
    bitmap.close();
  }
}
