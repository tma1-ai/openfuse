import Link from "next/link";
import { VersionLabel } from "./VersionLabel";
import { env } from "@/src/env.mjs";

export const LangfuseIcon = ({
  size = 32,
  className,
}: {
  size?: number;
  className?: string;
}) => (
  // eslint-disable-next-line @next/next/no-img-element
  <img
    src={`${env.NEXT_PUBLIC_BASE_PATH ?? ""}/openfuse-icon.png`}
    width={size}
    height={size}
    alt="Openfuse Icon"
    className={className}
  />
);

const LangfuseLogotypeOrCustomized = () => {
  return (
    <div className="flex items-center">
      {/* Expanded sidebar: Openfuse wordmark. The "fuse" half uses the brand teal so the wordmark
          matches the logo across light/dark themes ("Open" inherits the foreground color). Kept
          text-only (no leading icon) to preserve the original wordmark footprint next to the
          version label. */}
      <span className="text-foreground text-xl font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
        Open<span className="text-[#02CAA9]">fuse</span>
      </span>
      {/* Collapsed sidebar: icon only. */}
      <LangfuseIcon
        size={28}
        className="hidden scale-[1.2] group-data-[collapsible=icon]:block"
      />
    </div>
  );
};

export const LangfuseLogo = ({ version = false }: { version?: boolean }) => {
  return (
    <div className="-mt-2 ml-1 flex flex-wrap gap-4 lg:flex-col lg:items-start">
      {/* Langfuse Logo */}
      <div className="flex items-center">
        <Link href="/" className="flex items-center">
          <LangfuseLogotypeOrCustomized />
        </Link>
        {version && (
          <VersionLabel className="ml-2 group-data-[collapsible=icon]:hidden" />
        )}
      </div>
    </div>
  );
};
