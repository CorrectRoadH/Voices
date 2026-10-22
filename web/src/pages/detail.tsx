// @concord-file
// @concord-implements docs/feature/sentence-links/use-case/copy-sentence-link.md
// @concord-implements docs/feature/transcription/use-case/transcribe.md
import { segmentSpeakerName, labelName } from "@/lib/person-name";
import { tr, interfaceLocale } from "@/lib/i18n";
import { requestKey } from "@/lib/request-key";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  AudioLines,
  List,
  Copy,
  Link2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { SpeakerPicker } from "@/components/speaker-picker";
import { EmptyState, ErrorBox, Loading, Modal, Status } from "@/components/shared";
import { RecordingProgress } from "@/components/recording-progress";
import { InsightOutline, type InsightsResponse } from "@/components/transcription-insights";
import { Popover, PopoverTrigger, PopoverContent, PopoverTitle } from "@/components/ui/popover";
import { MessageBubble } from "@/components/message-bubble";
import { TranscriptSearch } from "@/components/transcript-search";
import { useTranscriptWindow } from "@/lib/use-transcript-window";
import { useSegmentPlayback } from "@/lib/use-segment-playback";
import { PersonAvatar } from "@/components/person-avatar";
import { LabelsEditor, RecordingField, SegmentEditor, SegmentText } from "@/components/editors";
import { OptionsFields, blankOptions, optionError } from "@/components/options";
import { useAction, useApp, useResource } from "@/lib/hooks";
import { request, write, apiUrl, errorMessage, downloadExport } from "@/lib/api";
import { sentenceMarkdown, sentenceUrl, copyText, validateAnchor } from "@/lib/links";
import { date, duration, bytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  Recording,
  Transcription,
  Segment,
  Options,
  Page,
  Person,
  Provider,
  Settings,
  Schema,
  Job,
} from "@/lib/types";
function isSpeakerContinuation(
  previous: Segment | undefined,
  current: Segment | undefined,
  recordedAt: string,
) {
  if (!previous || !current || current.ordinal !== previous.ordinal + 1) return false;
  const identity = (segment: Segment) => segment.person_id || segment.speaker_label_id || "unknown";
  const localDay = (segment: Segment) =>
    segment.start_ms === null
      ? null
      : new Date(new Date(recordedAt).getTime() + segment.start_ms).toDateString();
  return identity(previous) === identity(current) && localDay(previous) === localDay(current);
}

export function DetailPage() {
  const { recordingId = "", transcriptionId } = useParams();
  const [search] = useSearchParams();
  const anchor = search.get("segment");
  const navigate = useNavigate();
  const recording = useResource<Recording>(
    `/recordings/${encodeURIComponent(recordingId)}`,
    0,
    7000,
  );
  const versions = useResource<Page<Transcription>>(
    `/recordings/${encodeURIComponent(recordingId)}/transcriptions?limit=100`,
    0,
    7000,
    true,
  );
  const people = useResource<Page<Person>>("/people?limit=100&include_builtin=true", 0, 0, true);
  const providers = useResource<Page<Provider>>("/providers");
  const settings = useResource<Settings>("/settings");
  const jobs = useResource<Page<Job>>(
    `/jobs?recording_id=${encodeURIComponent(recordingId)}&limit=100`,
    0,
    7000,
    true,
  );
  const selected = transcriptionId || recording.data?.active_transcription_id || undefined;
  const selectedState = versions.data?.items.find((t) => t.id === selected)?.state;
  const [reload, setReload] = useState(0);
  const [textQuery, setTextQuery] = useState("");
  const [searchRevision, setSearchRevision] = useState(0);
  useEffect(() => setTextQuery(""), [recordingId, selected]);
  const [insightPoll, setInsightPoll] = useState(0);
  const insights = useResource<InsightsResponse>(
    selected ? `/transcriptions/${selected}/insights` : null,
    reload,
    insightPoll,
  );
  const insightKey = useRef(requestKey());
  useEffect(() => {
    setInsightPoll(
      insights.data?.insight && ["queued", "running"].includes(insights.data.insight.state)
        ? 2000
        : 0,
    );
  }, [insights.data?.insight?.state]);
  useEffect(() => {
    insightKey.current = requestKey();
  }, [selected]);
  const [showBuiltin, setShowBuiltin] = useState(!!anchor);
  const [speakerPicker, setSpeakerPicker] = useState<string | null>(null);
  const [editSegment, setEditSegment] = useState<Segment | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [railTab, setRailTab] = useState<string>("outline");
  const [metadataOpen, setMetadataOpen] = useState(true);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [manualCopy, setManualCopy] = useState("");
  const [options, setOptions] = useState<Options>(blankOptions);
  const [duplicateConsent, setDuplicateConsent] = useState(false);
  const [createKey, setCreateKey] = useState(() => requestKey());
  const action = useAction();
  const { session, notify } = useApp();
  const playback = useSegmentPlayback(JSON.stringify([recordingId, selected]), (message) =>
    notify(message, true),
  );
  const { queueSeek, flushSeek } = playback;
  const uncertain =
    jobs.data?.items.some((j) => ["uncertain", "restore_hold"].includes(j.state)) || false;
  const refresh = () => {
    setReload((n) => n + 1);
    versions.refresh();
    recording.refresh();
    people.refresh();
  };
  const readingGrid = useRef<HTMLDivElement>(null);
  const transcriptPanel = useRef<HTMLDivElement>(null);
  const playerPanel = useRef<HTMLDivElement>(null);
  const {
    version,
    segments,
    loadError,
    loading,
    paging,
    topSentinel,
    bottomSentinel,
    position: positionSegment,
    replaceSegment,
  } = useTranscriptWindow({
    recordingId,
    selected,
    selectedState,
    anchor,
    showBuiltin,
    reload,
    panelRef: transcriptPanel,
    playerPanelRef: playerPanel,
    queueSeek,
    flushSeek,
  });
  useLayoutEffect(() => {
    const grid = readingGrid.current;
    if (!grid) return;
    const measure = () => {
      const top = grid.getBoundingClientRect().top + window.scrollY;
      grid.style.setProperty(
        "--reading-height",
        `${Math.max(240, window.innerHeight - top - 120)}px`,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    const heading = document.querySelector(".detail-heading");
    if (heading) observer.observe(heading);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [recording.data?.id]);

  async function playSegment(segment: Segment) {
    if (segments && version) await playback.play(segment);
  }
  function jumpSearch(id: string) {
    playback.pause();
    if (anchor === id) positionSegment(id);
    else
      void navigate(
        `/recordings/${recordingId}/transcriptions/${selected}?segment=${encodeURIComponent(id)}`,
      );
  }
  async function generateInsights() {
    if (!selected) return;
    await action.run(
      async () => {
        const result = await write<InsightsResponse>(
          `/transcriptions/${selected}/insights`,
          "POST",
          {},
          insightKey.current,
        );
        insights.setData(result);
        insightKey.current = requestKey();
        insights.refresh();
      },
      undefined,
      "insights",
    );
  }
  async function jumpChapter(id: string) {
    try {
      const segment = await request<Segment>(`/segments/${id}`);
      if (!version) return;
      validateAnchor(recordingId, selected!, version, segment);
      setOutlineOpen(false);
      playback.pause();
      const timed =
        segment.start_ms !== null && segment.end_ms !== null && segment.end_ms > segment.start_ms;
      if (timed) {
        playback.seek(segment.start_ms!);
      } else notify(tr("该片段没有有效时间，仅定位正文。"));
      if (anchor === id) positionSegment(id);
      else navigate(`/recordings/${recordingId}/transcriptions/${selected}?segment=${id}`);
    } catch (error) {
      notify(errorMessage(error), true);
    }
  }
  async function copy(segment: Segment, markdown: boolean) {
    const text = markdown
      ? sentenceMarkdown(session.public_base_url, segment, location.origin)
      : sentenceUrl(session.public_base_url, segment, location.origin);
    if (await copyText(text)) notify(markdown ? tr("句子引用已复制") : tr("句子链接已复制"));
    else setManualCopy(text);
  }
  if (!recording.data)
    return (
      <>
        <Button variant="ghost" nativeButton={false} render={<Link to="/recordings" />}>
          <ArrowLeft data-icon="inline-start" />
          {tr("返回录音库")}{" "}
        </Button>
        {recording.loading ? (
          <Loading />
        ) : (
          <ErrorBox message={recording.error} retry={recording.refresh} />
        )}
      </>
    );
  const r = recording.data;
  const blocked = r.state === "deleting";
  if (blocked)
    return (
      <>
        <Button variant="ghost" nativeButton={false} render={<Link to="/recordings" />}>
          <ArrowLeft data-icon="inline-start" />
          {tr("返回录音库")}{" "}
        </Button>
        <Alert>
          <AlertTitle>{tr("录音正在清理")}</AlertTitle>
          <AlertDescription>
            {tr(
              "录音已停止访问。后台正在核对任务与清理远端资源；全部操作核对完成前，会保留待清理记录。",
            )}{" "}
          </AlertDescription>
        </Alert>
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link to={`/jobs?recording_id=${r.id}`} />}
        >
          {tr("查看清理任务")}{" "}
        </Button>
      </>
    );
  const createError = optionError(options, providers.data?.items || [], r);
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link to="/recordings" />}>
          <ArrowLeft data-icon="inline-start" />
          {tr("录音库")}{" "}
        </Button>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={tr("删除录音")}
            onClick={() => setDeleteOpen(true)}
            disabled={blocked}
          >
            <Trash2 />
          </Button>
        </div>
      </div>
      <header className="detail-heading">
        <div className="flex flex-wrap items-center gap-3">
          <Status value={r.state} />
        </div>
        <RecordingField key={r.id} field="title" recording={r} onSaved={recording.refresh} />
      </header>
      <ErrorBox message={recording.error || versions.error} retry={refresh} />
      <ErrorBox message={people.error} retry={people.refresh} />
      <ErrorBox message={settings.error} retry={settings.refresh} />
      {blocked ? (
        <Alert>
          <AlertTitle>{tr("录音正在清理")}</AlertTitle>
          <AlertDescription>
            {tr("录音已停止访问，后台仍在核对任务与清理远端资源。请在任务页查看状态。")}{" "}
          </AlertDescription>
        </Alert>
      ) : (
        <div className="player-panel" ref={playerPanel}>
          <div className="player-icon">
            <AudioLines />
          </div>
          <div className="player-content">
            <div className="player-caption">
              <p className="truncate text-xs font-medium">{r.title || r.original_name}</p>
              <Popover open={outlineOpen} onOpenChange={setOutlineOpen}>
                <PopoverTrigger render={<Button variant="ghost" size="xs" />}>
                  <List data-icon="inline-start" />
                  {tr("目录")}
                </PopoverTrigger>
                <PopoverContent
                  side="top"
                  align="end"
                  finalFocus={false}
                  className="max-h-[55dvh] overflow-y-auto"
                >
                  <PopoverTitle>{tr("录音目录")}</PopoverTitle>
                  <Tabs defaultValue="outline">
                    <TabsList className="w-full">
                      <TabsTrigger value="outline">{tr("目录")}</TabsTrigger>
                      <TabsTrigger value="summary">{tr("摘要")}</TabsTrigger>
                    </TabsList>
                    <TabsContent value="outline">
                      <InsightOutline
                        hasTranscription={!!selected}
                        data={insights.data}
                        error={insights.error}
                        busy={action.pendingKey === "insights"}
                        disabled={
                          !selected ||
                          blocked ||
                          session.restore_mode ||
                          version?.state !== "succeeded"
                        }
                        onGenerate={() => void generateInsights()}
                        onRefresh={insights.refresh}
                        onJump={(id) => void jumpChapter(id)}
                      />
                    </TabsContent>
                    <TabsContent value="summary">
                      <InsightOutline
                        view="summary"
                        hasTranscription={!!selected}
                        data={insights.data}
                        error={insights.error}
                        busy={action.pendingKey === "insights"}
                        disabled={
                          !selected ||
                          blocked ||
                          session.restore_mode ||
                          version?.state !== "succeeded"
                        }
                        onGenerate={() => void generateInsights()}
                        onRefresh={insights.refresh}
                        onJump={(id) => void jumpChapter(id)}
                      />
                    </TabsContent>
                  </Tabs>
                </PopoverContent>
              </Popover>
            </div>
            {r.state === "ready" ? (
              <audio
                {...playback.audioProps}
                key={r.id}
                controls
                preload="metadata"
                src={apiUrl(`/recordings/${r.id}/audio`)}
                aria-label={tr("录音播放器")}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                {tr("播放副本")}{" "}
                {r.state === "failed"
                  ? tr("生成失败，请在任务页检查。")
                  : tr("准备中，完成后可播放。")}
              </p>
            )}
            {playback.failed && (
              <p className="text-sm text-destructive">
                {tr("音频暂时无法加载，请刷新会话或稍后重试。")}
              </p>
            )}
          </div>
        </div>
      )}
      <div className="detail-grid" ref={readingGrid}>
        <Card className="transcript-card" ref={transcriptPanel}>
          {selected && (selectedState === "succeeded" || version?.state === "succeeded") && (
            <TranscriptSearch
              key={selected}
              transcriptionId={selected}
              revision={reload + searchRevision}
              query={textQuery}
              onQuery={setTextQuery}
              anchor={anchor}
              onJump={jumpSearch}
            />
          )}
          <CardContent>
            <ErrorBox message={loadError} retry={() => setReload((n) => n + 1)} />
            {loading ? (
              <Loading />
            ) : (!selected || (version && version.state !== "succeeded")) && !loadError ? (
              <>
                <ErrorBox message={jobs.error} retry={jobs.refresh} />
                <RecordingProgress
                  recording={r}
                  transcription={
                    selected
                      ? version
                      : versions.data?.items.find(
                          (item) => !["succeeded", "failed", "cancelled"].includes(item.state),
                        ) || versions.data?.items[0]
                  }
                  jobs={jobs.data?.items || []}
                  loading={versions.loading}
                  onManage={() => {
                    setRailTab("info");
                    setVersionsOpen(true);
                    requestAnimationFrame(() =>
                      document
                        .getElementById("recording-versions")
                        ?.scrollIntoView({ block: "nearest" }),
                    );
                  }}
                />
              </>
            ) : version && segments ? (
              <>
                {version.error_code && (
                  <Alert variant="destructive">
                    <AlertTitle>{tr("转写未完成")}</AlertTitle>
                    <AlertDescription>
                      {tr("错误代码：")}
                      {version.error_code}
                      {tr("。可在任务页查看处理状态。")}{" "}
                    </AlertDescription>
                  </Alert>
                )}
                <div className="segments relative">
                  {segments.previous_cursor && (
                    <div ref={topSentinel} className="h-px shrink-0" aria-hidden="true" />
                  )}
                  {paging === "previous" && (
                    <p
                      role="status"
                      className="absolute inset-x-0 top-0 text-center text-xs text-muted-foreground"
                    >
                      {tr("正在加载…")}
                    </p>
                  )}
                  {segments.items.map((segment, index) => {
                    const instant =
                      segment.start_ms === null
                        ? null
                        : new Date(new Date(r.recorded_at).getTime() + segment.start_ms);
                    const previous = segments.items[index - 1];
                    const previousDate =
                      previous?.start_ms == null
                        ? null
                        : new Date(
                            new Date(r.recorded_at).getTime() + previous.start_ms,
                          ).toLocaleDateString(interfaceLocale());
                    return (
                      <Fragment key={segment.id}>
                        {instant &&
                          instant.toLocaleDateString(interfaceLocale()) !== previousDate && (
                            <div className="chat-date">
                              {instant.toLocaleDateString(interfaceLocale())}
                            </div>
                          )}
                        <article
                          id={`segment-${segment.id}`}
                          key={segment.id}
                          className={cn(
                            "segment",
                            isSpeakerContinuation(previous, segment, r.recorded_at) &&
                              "segment-continuation",
                            isSpeakerContinuation(
                              segment,
                              segments.items[index + 1],
                              r.recorded_at,
                            ) && "segment-has-next",
                            people.data?.items.some(
                              (p) => p.id === segment.person_id && p.is_self,
                            ) && "segment-self",
                          )}
                          tabIndex={anchor === segment.id ? -1 : undefined}
                        >
                          <div className="segment-avatar">
                            {version.speaker_labels.find(
                              (label) => label.id === segment.speaker_label_id,
                            ) ? (
                              <SpeakerPicker
                                label={version.speaker_labels.find(
                                  (label) => label.id === segment.speaker_label_id,
                                )!}
                                name={segmentSpeakerName(segment)}
                                people={people.data?.items || []}
                                disabled={blocked}
                                onSaved={refresh}
                                open={speakerPicker === segment.id}
                                onOpenChange={(open) => setSpeakerPicker(open ? segment.id : null)}
                              >
                                <PersonAvatar
                                  id={segment.person_id || segment.speaker_label_id || "unknown"}
                                  name={segmentSpeakerName(segment)}
                                  person={people.data?.items.find(
                                    (p) => p.id === segment.person_id,
                                  )}
                                />
                              </SpeakerPicker>
                            ) : (
                              <PersonAvatar
                                id={segment.person_id || segment.speaker_label_id || "unknown"}
                                name={segmentSpeakerName(segment)}
                                person={people.data?.items.find((p) => p.id === segment.person_id)}
                              />
                            )}
                          </div>
                          <MessageBubble
                            metadata={
                              <>
                                {segment.edited_text !== null &&
                                  segment.edited_text !== segment.source_text && (
                                    <span className="message-edited">{tr("已校正")}</span>
                                  )}
                                <Button
                                  className="message-time"
                                  variant="ghost"
                                  size="sm"
                                  disabled={
                                    segment.start_ms === null || r.state !== "ready" || blocked
                                  }
                                  onClick={() => void playSegment(segment)}
                                  aria-label={tr("播放 {{v0}} 至本句结束", {
                                    v0: duration(segment.start_ms),
                                  })}
                                  title={
                                    instant
                                      ? tr("{{v0}} · 音频 {{v1}}", {
                                          v0: instant.toLocaleString(interfaceLocale(), {
                                            hour12: false,
                                          }),
                                          v1: duration(segment.start_ms),
                                        })
                                      : tr("缺少时间")
                                  }
                                >
                                  <Play />
                                </Button>
                              </>
                            }
                            actions={
                              <>
                                <DropdownMenuItem
                                  disabled={
                                    segment.start_ms === null || r.state !== "ready" || blocked
                                  }
                                  onClick={() => void playSegment(segment)}
                                >
                                  <Play />
                                  {tr("播放本句")}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() =>
                                    void copyText(segment.text).then((ok) => {
                                      if (ok) notify(tr("文字已复制"));
                                      else setManualCopy(segment.text);
                                    })
                                  }
                                >
                                  <Copy />
                                  {tr("复制文字")}
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => void copy(segment, true)}>
                                  <Copy />
                                  {tr("复制引用")}
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => void copy(segment, false)}>
                                  <Link2 />
                                  {tr("链接")}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  disabled={blocked}
                                  onClick={() => setEditSegment(segment)}
                                >
                                  <Pencil />
                                  {tr("编辑当前片段")}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  disabled={
                                    blocked ||
                                    !version.speaker_labels.some(
                                      (label) => label.id === segment.speaker_label_id,
                                    )
                                  }
                                  onClick={() => setSpeakerPicker(segment.id)}
                                >
                                  <Users />
                                  {tr("批量关联说话人")}
                                </DropdownMenuItem>
                              </>
                            }
                          >
                            <div className="segment-top">
                              <div>
                                {version.speaker_labels.find(
                                  (label) => label.id === segment.speaker_label_id,
                                ) ? (
                                  <SpeakerPicker
                                    label={version.speaker_labels.find(
                                      (label) => label.id === segment.speaker_label_id,
                                    )!}
                                    name={segmentSpeakerName(segment)}
                                    people={people.data?.items || []}
                                    disabled={blocked}
                                    onSaved={refresh}
                                  />
                                ) : (
                                  <strong>{segmentSpeakerName(segment)}</strong>
                                )}
                              </div>
                            </div>
                            <SegmentText
                              segment={segment}
                              searchQuery={textQuery}
                              disabled={blocked}
                              onSaved={(saved) => {
                                setSearchRevision((value) => value + 1);
                                replaceSegment(saved);
                                insights.refresh();
                              }}
                            />
                          </MessageBubble>
                        </article>
                      </Fragment>
                    );
                  })}
                </div>
                {!segments.items.length && (
                  <EmptyState
                    title={
                      version.state === "succeeded"
                        ? tr("没有可显示的片段，可开启内置人物片段显示")
                        : tr("转写处理中")
                    }
                    description={tr("后台任务会继续运行，可在任务页查看实际阶段。")}
                  >
                    <Button variant="outline" onClick={refresh}>
                      <RefreshCw data-icon="inline-start" />
                      {tr("刷新结果")}{" "}
                    </Button>
                  </EmptyState>
                )}
                {segments.next_cursor && (
                  <div
                    ref={bottomSentinel}
                    className="h-8 text-center text-xs text-muted-foreground"
                    aria-live="polite"
                  >
                    {paging ? tr("正在加载…") : tr("继续滚动加载更多")}
                  </div>
                )}
              </>
            ) : null}
          </CardContent>
          {version?.state === "succeeded" && (
            <CardFooter>
              <span className="text-xs text-muted-foreground">
                {tr("引用绑定当前版本，人工修改后链接保持有效。")}{" "}
              </span>
            </CardFooter>
          )}
        </Card>
        <aside className="detail-aside">
          <Tabs
            value={railTab}
            onValueChange={(value) => setRailTab(String(value))}
            className="sidebar-tabs"
          >
            <TabsList className="w-full" aria-label={tr("录音侧栏")}>
              <TabsTrigger value="outline">{tr("目录")}</TabsTrigger>
              <TabsTrigger value="summary">{tr("摘要")}</TabsTrigger>
              <TabsTrigger value="info">{tr("录音信息")}</TabsTrigger>
            </TabsList>
            <TabsContent value="outline">
              <div className="desktop-outline">
                <InsightOutline
                  hasTranscription={!!selected}
                  data={insights.data}
                  error={insights.error}
                  busy={action.pendingKey === "insights"}
                  disabled={
                    !selected || blocked || session.restore_mode || version?.state !== "succeeded"
                  }
                  onGenerate={() => void generateInsights()}
                  onRefresh={insights.refresh}
                  onJump={(id) => void jumpChapter(id)}
                />
              </div>
            </TabsContent>
            <TabsContent value="summary">
              <InsightOutline
                view="summary"
                hasTranscription={!!selected}
                data={insights.data}
                error={insights.error}
                busy={action.pendingKey === "insights"}
                disabled={
                  !selected || blocked || session.restore_mode || version?.state !== "succeeded"
                }
                onGenerate={() => void generateInsights()}
                onRefresh={insights.refresh}
                onJump={(id) => void jumpChapter(id)}
              />
            </TabsContent>
            <TabsContent value="info" keepMounted>
              <details
                id="recording-metadata"
                className="recording-tools"
                open={metadataOpen}
                onToggle={(event) => setMetadataOpen(event.currentTarget.open)}
              >
                <summary>{tr("录音信息")}</summary>
                <dl className="recording-facts">
                  <div>
                    <dt>{tr("开始时间")}</dt>
                    <dd>
                      <RecordingField
                        key={r.id}
                        field="recorded_at"
                        recording={r}
                        onSaved={recording.refresh}
                      />
                    </dd>
                  </div>
                  {(r.recorded_at_source === "import" || r.recorded_at_source === "imported") && (
                    <div>
                      <dd>{tr("暂用导入时间，请校准")}</dd>
                    </div>
                  )}
                  <div>
                    <dt>{tr("时长 / 大小")}</dt>
                    <dd>
                      {duration(r.duration_ms)} · {bytes(r.size_bytes)}
                    </dd>
                  </div>
                  <div>
                    <dt>{tr("原文件")}</dt>
                    <dd>{r.original_name}</dd>
                  </div>
                  <div>
                    <dt>{tr("备注")}</dt>
                    <dd>
                      <RecordingField
                        key={r.id}
                        field="notes"
                        recording={r}
                        onSaved={recording.refresh}
                      />
                    </dd>
                  </div>
                </dl>
              </details>
              <details
                className="recording-tools"
                id="recording-versions"
                open={versionsOpen}
                onToggle={(event) => setVersionsOpen(event.currentTarget.open)}
              >
                <summary>{tr("版本与导出")}</summary>
                <Card>
                  <CardContent className="flex flex-col gap-3">
                    <FieldGroup>
                      <Field>
                        <FieldLabel htmlFor="version">{tr("转写版本")}</FieldLabel>
                        <NativeSelect
                          id="version"
                          value={selected || ""}
                          onChange={(e) => {
                            if (e.target.value)
                              navigate(`/recordings/${r.id}/transcriptions/${e.target.value}`);
                          }}
                        >
                          <NativeSelectOption value="">{tr("尚无激活版本")}</NativeSelectOption>
                          {selected && !versions.data?.items.some((t) => t.id === selected) && (
                            <NativeSelectOption value={selected}>
                              {tr("指定版本")} {selected}
                            </NativeSelectOption>
                          )}
                          {versions.data?.items.map((t) => (
                            <NativeSelectOption key={t.id} value={t.id}>
                              {date(t.created_at)} · {t.provider}/{t.model} ·{" "}
                              {t.id === r.active_transcription_id ? tr("当前激活") : t.state}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                      </Field>
                    </FieldGroup>
                    <Button
                      size="sm"
                      disabled={blocked}
                      onClick={() => {
                        setOptions(settings.data?.default_transcription || blankOptions);
                        setDuplicateConsent(false);
                        setCreateKey(requestKey());
                        setNewOpen(true);
                      }}
                    >
                      <Plus data-icon="inline-start" />
                      {tr("新建转写")}{" "}
                    </Button>
                    {version && (
                      <div className="version-meta">
                        <Status value={version.state} />
                        <span>
                          {version.provider} / {version.model}
                        </span>
                        {version.id !== r.active_transcription_id && (
                          <Badge variant="outline">{tr("独立版本")}</Badge>
                        )}
                      </div>
                    )}
                    {version ? (
                      <>
                        <p className="truncate text-xs text-muted-foreground" title={version.id}>
                          {tr("版本：")}
                          {version.provider} / {version.model}
                        </p>
                        <p className="text-sm">{date(version.created_at)}</p>
                        {version.id === r.active_transcription_id ? (
                          <Badge variant="secondary" className="w-fit">
                            {tr("当前激活版本")}
                          </Badge>
                        ) : (
                          <Button
                            loading={action.pendingKey === "activate"}
                            variant="outline"
                            size="sm"
                            disabled={
                              version.state !== "succeeded" ||
                              version.id === r.active_transcription_id ||
                              action.busy ||
                              blocked
                            }
                            onClick={() =>
                              void action.run(
                                async () => {
                                  await write(`/transcriptions/${version.id}/activate`, "POST", {
                                    revision: version.revision,
                                  });
                                  recording.refresh();
                                },
                                tr("已设为激活版本"),
                                "activate",
                              )
                            }
                          >
                            {tr("设为激活版本")}{" "}
                          </Button>
                        )}
                        <Separator />
                        <p className="text-sm font-medium">{tr("下载转写")}</p>
                        <div className="flex flex-wrap gap-2">
                          {["txt", "srt", "json"].map((format) => (
                            <Button
                              loading={action.pendingKey === `export-${format}`}
                              variant="outline"
                              size="sm"
                              key={format}
                              disabled={
                                version.state !== "succeeded" ||
                                action.busy ||
                                blocked ||
                                (format === "srt" &&
                                  !!segments?.items.some(
                                    (s) => s.start_ms === null || s.end_ms === null,
                                  ))
                              }
                              onClick={() =>
                                void action.run(
                                  () => downloadExport(version.id, format),
                                  undefined,
                                  `export-${format}`,
                                )
                              }
                            >
                              {format.toUpperCase()}
                            </Button>
                          ))}
                        </div>
                        {segments?.items.some(
                          (segment) => segment.start_ms === null || segment.end_ms === null,
                        ) && (
                          <p className="text-xs text-muted-foreground">
                            {tr("含无时间片段，暂不支持 SRT。")}
                          </p>
                        )}
                        {!["succeeded", "cancelled", "failed"].includes(version.state) && (
                          <Button
                            variant="outline"
                            disabled={action.busy || blocked}
                            onClick={() => setCancelOpen(true)}
                          >
                            {tr("取消当前转写")}{" "}
                          </Button>
                        )}
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {tr("选择一个转写版本后，可激活或导出。")}
                      </p>
                    )}
                  </CardContent>
                  <CardFooter>
                    <Button
                      variant="link"
                      size="sm"
                      nativeButton={false}
                      render={<Link to={`/jobs?recording_id=${r.id}`} />}
                    >
                      {tr("查看处理任务")}{" "}
                    </Button>
                  </CardFooter>
                </Card>
              </details>
              <details className="recording-tools">
                <summary>{tr("说话人与人物")}</summary>
                <Card>
                  <CardContent className="flex flex-col gap-3">
                    {version?.speaker_labels.length ? (
                      version.speaker_labels.map((label) => (
                        <div className="flex items-center gap-2 text-sm" key={label.id}>
                          <span>{label.display_name}</span>
                          <span className="ml-auto text-muted-foreground">
                            {label.person_id
                              ? labelName(label, people.data?.items || [])
                              : tr("未关联")}
                          </span>
                        </div>
                      ))
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {tr("尚无说话人标签。即使模型未区分说话人，也能创建人工标签。")}{" "}
                      </p>
                    )}
                    <Field orientation="horizontal" className="mt-3">
                      <FieldLabel htmlFor="show-builtin">
                        {tr("显示背景声等内置人物片段")}
                      </FieldLabel>
                      <Switch
                        id="show-builtin"
                        checked={showBuiltin || !!anchor}
                        disabled={!!anchor}
                        onCheckedChange={(checked) => {
                          setShowBuiltin(checked);
                        }}
                      />
                    </Field>
                  </CardContent>
                  <CardFooter>
                    <Button
                      variant="outline"
                      className="w-full"
                      disabled={!version || blocked}
                      onClick={() => setLabelsOpen(true)}
                    >
                      {tr("管理标签与关联")}{" "}
                    </Button>
                  </CardFooter>
                </Card>
              </details>
            </TabsContent>
          </Tabs>
        </aside>
      </div>
      {editSegment && (
        <SegmentEditor
          segment={editSegment}
          labels={version?.speaker_labels || []}
          people={people.data?.items || []}
          onClose={() => setEditSegment(null)}
          onSaved={refresh}
        />
      )}
      {labelsOpen && version && (
        <LabelsEditor
          transcriptionId={version.id}
          labels={version.speaker_labels}
          people={people.data?.items || []}
          onClose={() => setLabelsOpen(false)}
          onSaved={refresh}
        />
      )}
      <Modal
        title={tr("新建转写版本")}
        description={tr("每次转写创建独立版本，不会覆盖已保存的文字或人物关联。")}
        open={newOpen}
        onOpenChange={setNewOpen}
      >
        <ErrorBox message={action.error} />
        <OptionsFields
          value={options}
          onChange={setOptions}
          providers={providers.data?.items || []}
        />
        <ErrorBox
          message={providers.error || jobs.error}
          retry={() => {
            providers.refresh();
            jobs.refresh();
          }}
        />
        {createError && (
          <p className="text-sm text-destructive" role="alert">
            {createError}
          </p>
        )}
        <FieldGroup>
          {uncertain && (
            <>
              <Alert variant="destructive">
                <AlertTitle>{tr("已有任务尚未核实")}</AlertTitle>
                <AlertDescription>
                  {tr("新的转写可能造成重复收费；旧任务继续保留，需核对远端 ID 和清理状态。")}{" "}
                </AlertDescription>
              </Alert>
              <Field orientation="horizontal">
                <FieldLabel htmlFor="duplicate-consent">
                  {tr("我接受可能重复收费，另建新版本")}
                </FieldLabel>
                <Switch
                  id="duplicate-consent"
                  checked={duplicateConsent}
                  onCheckedChange={setDuplicateConsent}
                />
              </Field>
            </>
          )}
          <Button
            loading={action.pendingKey === "transcribe"}
            disabled={
              action.busy ||
              !!createError ||
              jobs.loading ||
              !!jobs.error ||
              (uncertain && !duplicateConsent)
            }
            onClick={() =>
              void action.run(
                async () => {
                  const result = await write<Schema["TranscriptionCreated"]>(
                    `/recordings/${r.id}/transcriptions`,
                    "POST",
                    {
                      ...options,
                      diarization: true,
                      ...(uncertain ? { acknowledge_duplicate_risk: duplicateConsent } : {}),
                    },
                    createKey,
                  );
                  setNewOpen(false);
                  versions.refresh();
                  navigate(`/recordings/${r.id}/transcriptions/${result.transcription.id}`);
                },
                tr("转写已加入后台任务"),
                "transcribe",
              )
            }
          >
            {tr("开始转写")}{" "}
          </Button>
        </FieldGroup>
      </Modal>
      <Modal
        title={tr("删除这条录音？")}
        description={tr(
          "录音将立即停止访问，音频与已知服务商资源在后台清理。结果待确认的远端操作会继续保留核对记录。",
        )}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      >
        <ErrorBox message={action.error} />
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setDeleteOpen(false)}>
            {tr("保留录音")}{" "}
          </Button>
          <Button
            loading={action.pendingKey === "delete"}
            variant="destructive"
            disabled={action.busy}
            onClick={() =>
              void action.run(
                async () => {
                  await write(`/recordings/${r.id}`, "DELETE");
                  setDeleteOpen(false);
                  navigate("/recordings");
                },
                tr("已请求删除，后台正在清理"),
                "delete",
              )
            }
          >
            {tr("确认删除")}{" "}
          </Button>
        </div>
      </Modal>
      <Modal
        title={tr("取消当前转写？")}
        description={tr(
          "将停止在本地使用该结果。若服务商不支持中止，仍可能计费；后台会继续核对与清理资源。",
        )}
        open={cancelOpen}
        onOpenChange={setCancelOpen}
      >
        <ErrorBox message={action.error} />
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setCancelOpen(false)}>
            {tr("返回")}{" "}
          </Button>
          <Button
            loading={action.pendingKey === "cancel"}
            disabled={action.busy}
            onClick={() =>
              version &&
              void action.run(
                async () => {
                  await write(`/transcriptions/${version.id}/cancel`, "POST", {});
                  setCancelOpen(false);
                  refresh();
                },
                tr("取消请求已接受"),
                "cancel",
              )
            }
          >
            {tr("确认取消")}{" "}
          </Button>
        </div>
      </Modal>
      <Modal
        title={tr("手动复制")}
        description={tr("浏览器无法使用剪贴板，请选中下方内容后复制。")}
        open={!!manualCopy}
        onOpenChange={(v) => {
          if (!v) setManualCopy("");
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="manual-copy">{tr("引用内容")}</FieldLabel>
            <Textarea
              id="manual-copy"
              readOnly
              value={manualCopy}
              rows={5}
              onFocus={(e) => e.target.select()}
            />
          </Field>
          <FieldDescription>{tr("Windows / Linux 按 Ctrl+C，macOS 按 ⌘C。")}</FieldDescription>
        </FieldGroup>
      </Modal>
    </>
  );
}
