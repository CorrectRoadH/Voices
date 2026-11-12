// @concord-file
// @concord-implements docs/feature/recording-library/README.md
import { DatePicker } from "@/components/date-picker";
import {
  Item,
  ItemGroup,
  ItemMedia,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from "@/components/ui/item";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { tr } from "@/lib/i18n";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AudioLines, ArrowUpRight, CalendarDays, Plus, Search, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";

import { UploadDialog } from "@/components/upload";
import { PageHeading, EmptyState, ErrorBox, Loading, More, Status } from "@/components/shared";
import { useDebouncedValue, useResource } from "@/lib/hooks";
import { duration, bytes, date, localDateValue } from "@/lib/format";
import type { Recording, Person, Provider, Settings, Page } from "@/lib/types";
import { usePagedResource } from "@/lib/use-paged-resource";
export function RecordingRows({ items }: { items: Recording[] }) {
  return (
    <ItemGroup className="recording-list">
      {items.map((recording) => (
        <Item
          className="recording-row"
          variant="outline"
          key={recording.id}
          render={<Link to={`/recordings/${recording.id}`} />}
        >
          <ItemMedia variant="icon">
            <AudioLines />
          </ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle className="max-w-full">
              <span className="truncate">{recording.title || recording.original_name}</span>
            </ItemTitle>
            <ItemDescription>
              {date(recording.recorded_at)} ·{" "}
              {recording.recorded_at_source === "import" ||
              recording.recorded_at_source === "imported"
                ? tr("导入时间")
                : tr("录制时间")}
            </ItemDescription>
            {!!recording.people?.length && (
              <ItemDescription title={recording.people.map((p) => p.display_name).join("、")}>
                {tr("人物：")}
                {recording.people.map((p) => p.display_name).join("、")}
              </ItemDescription>
            )}
          </ItemContent>
          <ItemContent className="hidden flex-none sm:flex">
            <ItemDescription>
              {duration(recording.duration_ms)} · {bytes(recording.size_bytes)}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Status value={recording.state} />
            <ArrowUpRight className="size-4" />
          </ItemActions>
        </Item>
      ))}
    </ItemGroup>
  );
}
export function LibraryPage() {
  const [search, setSearch] = useSearchParams();
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<File[]>();
  const params = search.toString();
  const settledQuery = useDebouncedValue(search.get("q") || "");
  const requestParams = new URLSearchParams(search);
  if (settledQuery) requestParams.set("q", settledQuery);
  else requestParams.delete("q");
  const recordings = usePagedResource<Recording>(
    `/recordings?${requestParams}&limit=30`,
    "library",
  );
  const items = recordings.items;
  const updating = recordings.updating || settledQuery !== (search.get("q") || "");
  const people = useResource<Page<Person>>("/people?archived=false&limit=100", 0, 0, true);
  const providers = useResource<Page<Provider>>("/providers");
  const settings = useResource<Settings>("/settings");
  const filter = (key: string, value: string) => {
    const next = new URLSearchParams(search);
    value ? next.set(key, value) : next.delete(key);
    setSearch(next, { replace: true });
  };
  const refresh = recordings.refresh;
  return (
    <>
      <PageHeading title={tr("录音库")}>
        <Button
          onClick={() => {
            setFiles(undefined);
            setOpen(true);
          }}
        >
          <Plus data-icon="inline-start" />
          {tr("导入录音")}{" "}
        </Button>
      </PageHeading>
      <Empty
        className="mb-6 border border-dashed"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          setFiles(Array.from(e.dataTransfer.files));
          setOpen(true);
        }}
      >
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <UploadCloud />
          </EmptyMedia>
          <EmptyTitle>{tr("拖入音频")}</EmptyTitle>
          <EmptyDescription>{tr("或点击选择文件 · 支持批量上传")}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            variant="outline"
            onClick={() => {
              setFiles(undefined);
              setOpen(true);
            }}
          >
            <Plus data-icon="inline-start" />
            {tr("选择文件")}
          </Button>
        </EmptyContent>
      </Empty>
      <section className="flex flex-col gap-4" aria-label={tr("全部录音")}>
        <header>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-medium">{tr("全部录音")}</h2>
            </div>
            <Button
              size="sm"
              variant="ghost"
              aria-busy={recordings.updating}
              disabled={recordings.updating}
              onClick={refresh}
            >
              {recordings.updating && <Spinner data-icon="inline-start" aria-hidden="true" />}
              {tr("刷新")}{" "}
            </Button>
          </div>
        </header>
        <div>
          <FieldGroup className="filters">
            <Field>
              <FieldLabel htmlFor="recording-search" className="sr-only">
                {tr("搜索标题")}{" "}
              </FieldLabel>
              <InputGroup>
                <InputGroupAddon>
                  <Search />
                </InputGroupAddon>
                <InputGroupInput
                  id="recording-search"
                  placeholder={tr("搜索录音标题…")}
                  value={search.get("q") || ""}
                  onChange={(e) => filter("q", e.target.value)}
                />
              </InputGroup>
            </Field>
            <Field>
              <FieldLabel htmlFor="state-filter" className="sr-only">
                {tr("录音状态")}{" "}
              </FieldLabel>
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
              <FieldLabel htmlFor="person-filter" className="sr-only">
                {tr("人物")}{" "}
              </FieldLabel>
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
          <Collapsible className="date-filters">
            <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
              <CalendarDays className="size-4" />
              {tr("日期范围")}{" "}
            </CollapsibleTrigger>
            <CollapsibleContent keepMounted>
              <FieldGroup className="form-columns">
                <Field>
                  <FieldLabel htmlFor="from">{tr("开始日期")}</FieldLabel>
                  <DatePicker
                    id="from"
                    dateOnly
                    value={localDateValue(search.get("from"))}
                    onValueChange={(value) =>
                      filter("from", value ? new Date(`${value}T00:00:00`).toISOString() : "")
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="to">{tr("结束日期")}</FieldLabel>
                  <DatePicker
                    id="to"
                    dateOnly
                    value={localDateValue(search.get("to"))}
                    onValueChange={(value) =>
                      filter("to", value ? new Date(`${value}T23:59:59`).toISOString() : "")
                    }
                  />
                </Field>
              </FieldGroup>
            </CollapsibleContent>
          </Collapsible>
          {updating && items.length > 0 && <p role="status">{tr("正在更新…")}</p>}
          {recordings.stale && recordings.error && (
            <p role="status">{tr("筛选未更新，显示上次结果。")}</p>
          )}
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
                <Button variant="outline" onClick={() => setOpen(true)}>
                  {tr("导入音频")}{" "}
                </Button>
              </EmptyState>
            )
          )}
        </div>
        <footer className="flex items-center gap-3">
          <p className="text-xs text-muted-foreground">
            {tr("已显示 {{count}} 条录音", { count: items.length })}
          </p>
          <div className="ml-auto">
            <More
              cursor={updating ? null : recordings.nextCursor}
              loading={recordings.loading}
              onLoad={recordings.loadMore}
            />
          </div>
        </footer>
      </section>
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
