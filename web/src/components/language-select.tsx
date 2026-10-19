// @concord-file
// @concord-implements docs/feature/interface-language/use-case/choose-language.md
import { useState } from "react";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { ErrorBox } from "@/components/shared";
import { useAction, useApp } from "@/lib/hooks";
import { write } from "@/lib/api";
import { chooseGuestLanguage, interfaceLocale, normalizeLanguage, tr } from "@/lib/i18n";
import type { User } from "@/lib/types";

function Languages() {
  return <>
    <NativeSelectOption value="zh-CN">简体中文</NativeSelectOption>
    <NativeSelectOption value="en">English</NativeSelectOption>
  </>;
}

export function GuestLanguageSelect() {
  return <Field>
    <FieldLabel htmlFor="guest-language">{tr("界面语言")}</FieldLabel>
    <NativeSelect id="guest-language" value={interfaceLocale()}
      onChange={(event) => chooseGuestLanguage(normalizeLanguage(event.target.value))}>
      <Languages />
    </NativeSelect>
  </Field>;
}

export function AccountLanguageSelect() {
  const { session, updateUser } = useApp();
  const action = useAction();
  const [saved, setSaved] = useState(false);
  return <Field>
    <FieldLabel htmlFor="account-language">{tr("界面语言")}</FieldLabel>
    <NativeSelect id="account-language" value={normalizeLanguage(session.user.ui_language)}
      disabled={action.busy || session.restore_mode}
      onChange={(event) => {
        const language = normalizeLanguage(event.target.value);
        if (language === normalizeLanguage(session.user.ui_language)) return;
        setSaved(false);
        void action.run(async () => {
          const user = await write<User>("/me", "PATCH", { ui_language: language });
          updateUser(user);
          setSaved(true);
        });
      }}>
      <Languages />
    </NativeSelect>
    <FieldDescription>{tr("语言随账号保存，不影响转写语言。")}</FieldDescription>
    <p role="status" className="text-sm text-muted-foreground">{action.busy ? tr("正在保存语言…") : saved ? tr("界面语言已保存") : ""}</p>
    <ErrorBox message={action.error} />
  </Field>;
}
