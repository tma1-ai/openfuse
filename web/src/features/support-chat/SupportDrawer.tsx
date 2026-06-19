import { useSupportDrawer } from "@/src/features/support-chat/SupportDrawerProvider";
import { Button } from "@/src/components/ui/button";
import { X } from "lucide-react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/src/components/ui/breadcrumb";
import { IntroSection } from "@/src/features/support-chat/IntroSection";
import { cn } from "@/src/utils/tailwind";

export const SupportDrawer = ({
  showCloseButton = true,
  className,
}: {
  showCloseButton?: boolean;
  className?: string;
}) => {
  const { open, setOpen } = useSupportDrawer();
  const close = () => setOpen(false);

  if (!open) return null;

  return (
    <div
      className={cn([
        "bg-background flex h-full w-full min-w-0 flex-col",
        className,
      ])}
    >
      <div className="bg-background">
        <div className="flex min-h-11 w-full items-center justify-between gap-1 px-4 py-1">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Support</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          {showCloseButton && (
            <Button
              variant="ghost"
              size="icon"
              onClick={close}
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto border-t">
        <div className="px-2 py-1">
          <div className="bg-background h-full">
            <div className="p-2">
              <IntroSection />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
