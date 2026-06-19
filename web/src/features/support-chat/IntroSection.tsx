import { Button } from "@/src/components/ui/button";
import { Bug, MessagesSquare } from "lucide-react";
import { SiGithub } from "react-icons/si";

const OPENFUSE_GITHUB = "https://github.com/tma1-ai/openfuse";

export function IntroSection() {
  return (
    <div className="mt-1 flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-base font-semibold">
          <SiGithub className="h-4 w-4" /> Community & Resources
        </div>
        <p className="text-muted-foreground text-sm">
          Openfuse is open source. Browse the code, report issues, and join the
          discussion on GitHub.
        </p>

        <Button asChild variant="outline">
          <a href={OPENFUSE_GITHUB} target="_blank" rel="noopener">
            <SiGithub className="mr-2 h-4 w-4" /> GitHub ↗
          </a>
        </Button>
        <Button asChild variant="outline">
          <a
            href={`${OPENFUSE_GITHUB}/issues/new`}
            target="_blank"
            rel="noopener"
          >
            <Bug className="mr-2 h-4 w-4" /> Report an issue ↗
          </a>
        </Button>
        <Button asChild variant="outline">
          <a
            href={`${OPENFUSE_GITHUB}/discussions`}
            target="_blank"
            rel="noopener"
          >
            <MessagesSquare className="mr-2 h-4 w-4" /> Discussions ↗
          </a>
        </Button>
      </div>
    </div>
  );
}
