import { Card } from "@/src/components/ui/card";
import { CodeView } from "@/src/components/ui/CodeJsonViewer";
import Header from "@/src/components/layouts/header";
import { env } from "@/src/env.mjs";

export function HostNameProject() {
  return (
    <div>
      <Header title="Host Name" />
      <Card className="mb-4 p-3">
        <div className="">
          <div className="mb-2 text-sm">
            When connecting to Langfuse, use this hostname / baseurl.
          </div>
          <CodeView
            content={`${window.origin}${env.NEXT_PUBLIC_BASE_PATH ?? ""}`}
          />
        </div>
      </Card>
    </div>
  );
}
