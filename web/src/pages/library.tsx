// @concord-file
// @concord-implements docs/feature/recording-library/README.md
import { tr } from "@/lib/i18n";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AudioLines, ArrowUpRight, CalendarDays, Plus, Search, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardFooter,
} from "@/components/ui/card";
import { UploadDialog } from "@/components/upload";
import { PageHeading, EmptyState, ErrorBox, Loading, More, Status } from "@/components/shared";
import { useResource } from "@/lib/hooks";
import { duration, bytes, date, localDateValue } from "@/lib/format";
import type { Recording, Person, Provider, Settings, Page } from "@/lib/types";
export function RecordingRows({ items }: { items: Recording[] }) {
  return (
    <div className="recording-list">
      {items.map((recording) => (
        <Link className="recording-row" key={recording.id} to={`/recordings/${recording.id}`}>
          <div className="recording-icon">
            <AudioLines />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate">{recording.title || recording.original_name}</h3>
            <p className="truncate text-sm text-muted-foreground">
              {date(recording.recorded_at)}
              <span className="row-detail">
                {" "}
                ·{" "}
                {recording.recorded_at_source === "import" ||
                recording.recorded_at_source === "imported"
                  ? tr("导入时间")
                  : tr("录制时间")}
              </span>
            </p>
            {!!recording.people?.length && <p className="truncate text-sm text-muted-foreground" title={recording.people.map((person) => person.display_name).join("、")}>{tr("人物：")}{recording.people.map((person) => person.display_name).join("、")}</p>}
          </div>
          <div className="row-detail text-sm tabular-nums text-muted-foreground">
            {duration(recording.duration_ms)}
            <p className="text-xs">{bytes(recording.size_bytes)}</p>
          </div>
          <Status value={recording.state} />
          <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" />
        </Link>
      ))}
    </div>
  );
}
export function LibraryPage() {
  const [search, setSearch] = useSearchParams();
  const [cursor, setCursor] = useState("");
  const [items, setItems] = useState<Recording[]>([]);
  const [revision, setRevision] = useState(0);
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<File[]>();
  const params = search.toString();
  useEffect(() => {
    setCursor("");
    setItems([]);
  }, [params]);
  const recordings = useResource<Page<Recording>>(
    `/recordings?${params}&limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    revision,
  );
  const people = useResource<Page<Person>>("/people?archived=false&limit=100", 0, 0, true);
  const providers = useResource<Page<Provider>>("/providers");
  const settings = useResource<Settings>("/settings");
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
  const filter = (key: string, value: string) => {
    const next = new URLSearchParams(search);
    value ? next.set(key, value) : next.delete(key);
    setSearch(next);
  };
  const refresh = () => {
    setCursor("");
    setRevision((n) => n + 1);
  };
  return (
    <>
      <PageHeading
        title={tr("录音库")}
      >
        <Button
          onClick={() => {
            setFiles(undefined);
            setOpen(true);
          }}
        >
          <Plus data-icon="inline-start" />{tr("导入录音")}{" "}</Button>
      </PageHeading>
      <button
        type="button"
        className="library-drop"
        onClick={() => {
          setFiles(undefined);
          setOpen(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          setFiles(Array.from(e.dataTransfer.files));
          setOpen(true);
        }}
      >
        <div className="drop-icon">
          <UploadCloud />
        </div>
        <div>
          <strong>{tr("拖入音频")}</strong>
          <p>{tr("或点击选择文件 · 支持批量上传")}</p>
        </div>
        <Plus className="ml-auto size-5 text-muted-foreground" />
      </button>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>{tr("全部录音")}</CardTitle>
            </div>
            <Button size="sm" variant="ghost" onClick={refresh}>{tr("刷新")}{" "}</Button>
          </div>
        </CardHeader>
        <CardContent>
          <FieldGroup className="filters">
            <Field>
              <FieldLabel htmlFor="recording-search" className="sr-only">{tr("搜索标题")}{" "}</FieldLabel>
              <div className="search-input">
                <Search />
                <Input
                  id="recording-search"
                  placeholder={tr("搜索录音标题…")}
                  value={search.get("q") || ""}
                  onChange={(e) => filter("q", e.target.value)}
                />
              </div>
            </Field>
            <Field>
              <FieldLabel htmlFor="state-filter" className="sr-only">{tr("录音状态")}{" "}</FieldLabel>
              <NativeSelect
                id="state-filter"
                value={search.get("state") || ""}
                onChange={(e) => filter("state", e.target.value)}
              >
                <NativeSelectOption value="">{tr("全部状态")}</NativeSelectOption>
                <NativeSelectOption value="ready">{tr("已就绪")}</NativeSelectOption>
                <NativeSelectOption value="preparing">{tr("预处理中")}</NativeSelectOption>
                <NativeSelectOption value="failed">{tr("失败")}</NativeSelectOption>
                <NativeSelectOption value="deleting">{tr("待清理")}</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="person-filter" className="sr-only">{tr("人物")}{" "}</FieldLabel>
              <NativeSelect
                id="person-filter"
                value={search.get("person_id") || ""}
                onChange={(e) => filter("person_id", e.target.value)}
              >
                <NativeSelectOption value="">{tr("全部人物")}</NativeSelectOption>
                {people.data?.items.map((p) => (
                  <NativeSelectOption value={p.id} key={p.id}>
                    {p.display_name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          </FieldGroup>
          <details className="date-filters">
            <summary>
              <CalendarDays className="size-4" />{tr("日期范围")}{" "}</summary>
            <FieldGroup className="form-columns">
              <Field>
                <FieldLabel htmlFor="from">{tr("开始日期")}</FieldLabel>
                <Input
                  id="from"
                  type="date"
                  value={localDateValue(search.get("from"))}
                  onChange={(e) =>
                    filter(
                      "from",
                      e.target.value ? new Date(`${e.target.value}T00:00:00`).toISOString() : "",
                    )
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="to">{tr("结束日期")}</FieldLabel>
                <Input
                  id="to"
                  type="date"
                  value={localDateValue(search.get("to"))}
                  onChange={(e) =>
                    filter(
                      "to",
                      e.target.value ? new Date(`${e.target.value}T23:59:59`).toISOString() : "",
                    )
                  }
                />
              </Field>
            </FieldGroup>
          </details>
          <ErrorBox message={recordings.error} retry={recordings.refresh} />
          <ErrorBox message={people.error} retry={people.refresh} />
          <ErrorBox message={providers.error} retry={providers.refresh} />
          <ErrorBox message={settings.error} retry={settings.refresh} />
          {recordings.loading && !items.length ? (
            <Loading />
          ) : items.length ? (
            <RecordingRows items={items} />
          ) : (
            !recordings.error && (
              <EmptyState
                title={params ? tr("没有找到匹配的录音") : tr("暂无录音")}
                description={
                  params ? tr("试试调整搜索词或筛选条件。") : tr("拖入音频或选择文件导入。")
                }
              >
                <Button variant="outline" onClick={() => setOpen(true)}>{tr("导入音频")}{" "}</Button>
              </EmptyState>
            )
          )}
        </CardContent>
        <CardFooter>
          <p className="text-xs text-muted-foreground">{tr("已显示 {{count}} 条录音", { count: items.length })}</p>
          <div className="ml-auto">
            <More
              cursor={recordings.data?.next_cursor}
              loading={recordings.loading}
              onLoad={setCursor}
            />
          </div>
        </CardFooter>
      </Card>
      {open && (
        <UploadDialog
          open={open}
          onOpenChange={setOpen}
          providers={providers.data?.items || []}
          settings={settings.data}
          onComplete={refresh}
          initialFiles={files}
        />
      )}
    </>
  );
}
