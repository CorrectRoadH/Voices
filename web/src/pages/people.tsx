// @concord-file
// @concord-implements docs/feature/people/use-case/link-person.md
import { personName } from "@/lib/person-name";
import { tr } from "@/lib/i18n";
import { requestKey } from "@/lib/request-key";
import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, Plus, Users } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { EmptyState, ErrorBox, Loading, Modal, More, PageHeading } from "@/components/shared";
import { useAction, useApp, useResource } from "@/lib/hooks";
import { write, query, errorMessage } from "@/lib/api";
import type { Person, Recording, Page } from "@/lib/types";
import { PersonAvatar, prepareAvatar } from "@/components/person-avatar";
import { RecordingRows } from "./library";
function PersonEditor({
  person,
  onClose,
  onSaved,
}: {
  person?: Person;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(person?.display_name || "");
  const [notes, setNotes] = useState(person?.notes || "");
  const [avatar, setAvatar] = useState<string | null | undefined>(undefined);
  const [avatarError, setAvatarError] = useState("");
  const { notify } = useApp();
  const [preparing, setPreparing] = useState(false);
  const [archived, setArchived] = useState(!!person?.archived_at);
  const [key] = useState(() => requestKey());
  const action = useAction();
  return (
    <Modal
      open
      onOpenChange={(v) => {
        if (!v && !action.busy) onClose();
      }}
      title={person ? tr("编辑人物") : tr("新建人物")}
      description={tr("显示名可以相同；归档后保留原有引用，不再新增关联。")}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await write(
              person ? `/people/${person.id}` : "/people",
              person ? "PATCH" : "POST",
              {
                display_name: name,
                notes,
                ...(avatar !== undefined ? { avatar_data: avatar } : {}),
                ...(person ? { revision: person.revision, archived } : {}),
              },
              person ? undefined : key,
            );
            onSaved();
            onClose();
          }, tr("人物已保存"));
        }}
      >
        <FieldGroup>
          <ErrorBox message={action.error || avatarError} />
          <Field>
            <FieldLabel htmlFor="person-avatar">{tr("头像")}</FieldLabel>
            <PersonAvatar id={person?.id || name} name={name} person={person} preview={avatar} />
            <Input
              id="person-avatar"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={action.busy || preparing}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                setPreparing(true);
                setAvatarError("");
                void prepareAvatar(file)
                  .then(setAvatar)
                  .catch((error: unknown) => {
                    const message = errorMessage(error);
                    setAvatarError(message);
                    notify(message, true);
                  })
                  .finally(() => setPreparing(false));
              }}
            />
            {(avatar || (avatar === undefined && person?.has_avatar)) && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setAvatar(null)}>
                {tr("移除头像")}
              </Button>
            )}
          </Field>
          <Field>
            <FieldLabel htmlFor="person-name">{tr("显示名")}</FieldLabel>
            <Input
              id="person-name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="person-notes">{tr("备注")}</FieldLabel>
            <Textarea
              id="person-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
            />
          </Field>
          {person && (
            <Field orientation="horizontal">
              <FieldLabel htmlFor="person-archive">{tr("归档人物")}</FieldLabel>
              <Switch id="person-archive" checked={archived} onCheckedChange={setArchived} />
            </Field>
          )}
          <Button type="submit" disabled={action.busy || preparing}>
            {tr("保存人物")}{" "}
          </Button>
        </FieldGroup>
      </form>
    </Modal>
  );
}
export function PeoplePage() {
  const [params, setParams] = useSearchParams();
  const [cursor, setCursor] = useState("");
  const [items, setItems] = useState<Person[]>([]);
  const [editing, setEditing] = useState<Person | "new" | null>(null);
  const data = useResource<Page<Person>>(
    `/people${query({ include_builtin: true, q: params.get("q"), archived: params.get("archived") || "false", cursor, limit: 30 })}`,
  );
  useEffect(() => {
    setCursor("");
    setItems([]);
  }, [params]);
  useEffect(() => {
    if (data.data)
      setItems((old) =>
        cursor
          ? [
              ...old.filter((p) => !data.data!.items.some((n) => n.id === p.id)),
              ...data.data!.items,
            ]
          : data.data!.items,
      );
  }, [data.data, cursor]);
  const filter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    value ? next.set(key, value) : next.delete(key);
    setParams(next, { replace: true });
  };
  return (
    <>
      <PageHeading title={tr("人物")}>
        <Button onClick={() => setEditing("new")}>
          <Plus data-icon="inline-start" />
          {tr("新建人物")}{" "}
        </Button>
      </PageHeading>
      <FieldGroup className="people-filters">
        <Field>
          <FieldLabel className="sr-only" htmlFor="people-search">
            {tr("搜索人物")}{" "}
          </FieldLabel>
          <Input
            id="people-search"
            value={params.get("q") || ""}
            placeholder={tr("搜索人物…")}
            onChange={(e) => filter("q", e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel className="sr-only" htmlFor="people-archived">
            {tr("归档状态")}{" "}
          </FieldLabel>
          <NativeSelect
            id="people-archived"
            value={params.get("archived") || "false"}
            onChange={(e) => filter("archived", e.target.value)}
          >
            <NativeSelectOption value="false">{tr("活跃人物")}</NativeSelectOption>
            <NativeSelectOption value="true">{tr("已归档人物")}</NativeSelectOption>
          </NativeSelect>
        </Field>
      </FieldGroup>
      <ErrorBox message={data.error} retry={data.refresh} />
      {data.loading && !items.length ? (
        <Loading />
      ) : items.length ? (
        <div className="people-grid">
          {items.map((p) => (
            <Link key={p.id} to={`/people/${p.id}`} className="person-card-link">
              <Card>
                <CardHeader>
                  <PersonAvatar id={p.id} name={personName(p)} person={p} />
                  <CardTitle>
                    {personName(p)} {p.builtin_key && <Badge variant="outline">{tr("内置")}</Badge>}{" "}
                    {p.is_self && <Badge>{tr("本人")}</Badge>}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="line-clamp-2 text-sm text-muted-foreground">
                    {p.archived_at
                      ? tr("已归档")
                      : p.notes || (p.builtin_key ? tr("内置人物") : tr("暂无备注"))}
                  </p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        !data.error && (
          <EmptyState
            title={tr("暂无人物")}
            description={tr("新建人物后，在录音详情里关联说话人标签。")}
          >
            <Button onClick={() => setEditing("new")}>
              <Users data-icon="inline-start" />
              {tr("新建人物")}{" "}
            </Button>
          </EmptyState>
        )
      )}
      <More cursor={data.data?.next_cursor} loading={data.loading} onLoad={setCursor} />
      {editing && (
        <PersonEditor
          person={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            if (editing === "new") setCursor("");
            data.refresh();
          }}
        />
      )}
    </>
  );
}
export function PersonPage() {
  const { personId = "" } = useParams();
  const person = useResource<Person>(`/people/${encodeURIComponent(personId)}`);
  const [cursor, setCursor] = useState("");
  const [items, setItems] = useState<Recording[]>([]);
  const recordings = useResource<Page<Recording>>(
    `/recordings${query({ person_id: personId, limit: 30, cursor })}`,
  );
  const [editing, setEditing] = useState(false);
  const selfAction = useAction();
  useEffect(() => {
    if (recordings.data)
      setItems((old) =>
        cursor
          ? [
              ...old.filter((r) => !recordings.data!.items.some((n) => n.id === r.id)),
              ...recordings.data!.items,
            ]
          : recordings.data!.items,
      );
  }, [recordings.data, cursor]);
  return (
    <>
      <Button variant="ghost" nativeButton={false} render={<Link to="/people" />}>
        <ArrowLeft data-icon="inline-start" />
        {tr("返回人物")}{" "}
      </Button>
      {person.loading ? (
        <Loading />
      ) : person.data ? (
        <>
          <PersonAvatar id={person.data.id} name={personName(person.data)} person={person.data} />
          <ErrorBox message={selfAction.error} />
          <PageHeading title={personName(person.data)} description={person.data.notes || undefined}>
            {!person.data.builtin_key && (
              <Button variant="outline" onClick={() => setEditing(true)}>
                {tr("编辑人物")}{" "}
              </Button>
            )}
            {!person.data.builtin_key && (
              <Button
                variant="ghost"
                disabled={selfAction.busy}
                onClick={() =>
                  void selfAction.run(
                    async () => {
                      const saved = await write<Person>(`/people/${person.data!.id}`, "PATCH", {
                        revision: person.data!.revision,
                        is_self: !person.data!.is_self,
                      });
                      person.setData(saved);
                    },
                    person.data!.is_self ? tr("已取消本人标记") : tr("已标记为本人"),
                  )
                }
              >
                {person.data.is_self ? tr("取消本人") : tr("标记为本人")}
              </Button>
            )}
            {person.data.is_self && <Badge>{tr("本人")}</Badge>}
            {person.data.builtin_key && <Badge variant="outline">{tr("内置")}</Badge>}
            {person.data.archived_at && <Badge variant="secondary">{tr("已归档")}</Badge>}
          </PageHeading>
          <Card>
            <CardHeader>
              <CardTitle>{tr("相关录音")}</CardTitle>
              <CardDescription>{tr("人物出现在当前激活转写版本中的录音。")}</CardDescription>
            </CardHeader>
            <CardContent>
              <ErrorBox message={recordings.error} retry={recordings.refresh} />
              {recordings.loading && !items.length ? (
                <Loading />
              ) : items.length ? (
                <RecordingRows items={items} />
              ) : (
                !recordings.error && (
                  <EmptyState
                    title={tr("还没有相关录音")}
                    description={tr("在录音详情中，将说话人标签关联至此人物。历史版本可单独查看。")}
                  />
                )
              )}
            </CardContent>
            <CardFooter>
              <More
                cursor={recordings.data?.next_cursor}
                loading={recordings.loading}
                onLoad={setCursor}
              />
            </CardFooter>
          </Card>
          {editing && (
            <PersonEditor
              person={person.data}
              onClose={() => setEditing(false)}
              onSaved={person.refresh}
            />
          )}
        </>
      ) : (
        <ErrorBox message={person.error} retry={person.refresh} />
      )}
    </>
  );
}
