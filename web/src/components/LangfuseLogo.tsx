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
    src={`${env.NEXT_PUBLIC_BASE_PATH ?? ""}/icon.svg`}
    width={size}
    height={size}
    alt="Langfuse Icon"
    className={className}
  />
);

const LangfuseLogotypeOrCustomized = () => {
  return (
    <div className="flex items-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="-ml-1.5 max-h-6 max-w-22 group-data-[collapsible=icon]:hidden dark:hidden"
        src={`${env.NEXT_PUBLIC_BASE_PATH ?? ""}/wordart-black.svg`}
        alt="Langfuse Logo"
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="-ml-1.5 hidden max-h-6 max-w-22 group-data-[collapsible=icon]:hidden dark:block"
        src={`${env.NEXT_PUBLIC_BASE_PATH ?? ""}/wordart-white.svg`}
        alt="Langfuse Logo"
      />
      <LangfuseIcon
        size={28}
        className="hidden scale-120 group-data-[collapsible=icon]:block"
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
