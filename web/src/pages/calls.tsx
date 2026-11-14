// @concord-file
// @concord-implements docs/feature/call-logs/use-case/inspect-calls.md
import { useSearchParams } from "react-router-dom";
import { CallLogs } from "@/components/call-logs";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { tr } from "@/lib/i18n";
import { AdminSTTCallsPage } from "@/pages/stt-pricing";

export function AdminCallsPage() {
  const [params, setParams] = useSearchParams();
  const costs = params.get("view") === "stt-costs";
  return (
    <>
      <Tabs
        value={costs ? "stt-costs" : "requests"}
        onValueChange={(value) => {
          setParams(value === "stt-costs" ? { view: "stt-costs" } : {});
        }}
        className="mb-5"
      >
        <TabsList>
          <TabsTrigger value="requests">{tr("请求记录")}</TabsTrigger>
          <TabsTrigger value="stt-costs">{tr("STT 费用")}</TabsTrigger>
        </TabsList>
      </Tabs>
      {costs ? <AdminSTTCallsPage /> : <CallLogs admin />}
    </>
  );
}
