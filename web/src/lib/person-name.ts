import { tr } from "./i18n";
import type { Person, Label, Segment } from "./types";

const builtinNames: Record<string, string> = {
  background: "背景声",
  music: "音乐",
  system_prompt: "系统提示音",
};

export function builtinPersonName(key: string | null | undefined, fallback: string) {
  return key && builtinNames[key] ? tr(builtinNames[key]) : fallback;
}

export function personName(person: Pick<Person, "builtin_key" | "display_name">) {
  return builtinPersonName(person.builtin_key, person.display_name);
}

export function labelName(label: Label, people: Person[]) {
  const person = people.find((item) => item.id === label.person_id);
  return person ? personName(person) : label.person_name || label.display_name;
}

export function segmentSpeakerName(
  segment: Pick<Segment, "speaker_label_id" | "person_id" | "person_builtin_key" | "speaker_name">,
) {
  if (!segment.speaker_label_id && !segment.person_id) return tr("未知说话人");
  return builtinPersonName(segment.person_builtin_key, segment.speaker_name);
}
