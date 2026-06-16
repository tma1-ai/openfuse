// ClickHouse is retired on the GreptimeDB backend. These two helpers are not
// ClickHouse clients — they are pure utilities that several converters and the
// shared SQL filter factory still depend on (a CH-flavoured date parse and a
// SQL-safe random identifier). Kept here until the TIER2 rename (issue #7).

import { RESOURCE_LIMIT_ERROR_MESSAGE } from "../../errors/errorMessages";

const ERROR_TYPE_CONFIG: Record<
  "MEMORY_LIMIT" | "OVERCOMMIT" | "TIMEOUT",
  {
    discriminators: string[];
  }
> = {
  MEMORY_LIMIT: {
    discriminators: ["memory limit exceeded"],
  },
  OVERCOMMIT: {
    discriminators: ["OvercommitTracker"],
  },
  TIMEOUT: {
    discriminators: ["Timeout", "timeout", "timed out"],
  },
};

type ErrorType = keyof typeof ERROR_TYPE_CONFIG;

// Compatibility error contract used by existing API/tRPC error formatting.
// This does not reintroduce the retired ClickHouse client.
export class ClickHouseResourceError extends Error {
  static ERROR_ADVICE_MESSAGE = RESOURCE_LIMIT_ERROR_MESSAGE;

  public readonly errorType: ErrorType;
  public readonly tags?: Record<string, string>;

  constructor(
    errType: ErrorType,
    originalError: Error,
    tags?: Record<string, string>,
  ) {
    super(originalError.message, { cause: originalError });
    this.name = "ClickHouseResourceError";
    this.errorType = errType;
    this.tags = tags;

    if (originalError.stack) {
      this.stack = originalError.stack;
    }
  }

  static wrapIfResourceError(
    originalError: Error,
    tags?: Record<string, string>,
  ): Error {
    const errorMessage = originalError.message || "";

    for (const [type, config] of Object.entries(ERROR_TYPE_CONFIG) as Array<
      [
        keyof typeof ERROR_TYPE_CONFIG,
        (typeof ERROR_TYPE_CONFIG)[keyof typeof ERROR_TYPE_CONFIG],
      ]
    >) {
      const hasDiscriminator = config.discriminators.some((discriminator) =>
        errorMessage.includes(discriminator),
      );

      if (hasDiscriminator) {
        return new ClickHouseResourceError(type, originalError, tags);
      }
    }

    return originalError;
  }
}

export function parseClickhouseUTCDateTimeFormat(dateStr: string): Date {
  return new Date(`${dateStr.replace(" ", "T")}Z`);
}

export function clickhouseCompliantRandomCharacters() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let result = "";
  const randomArray = new Uint8Array(5);
  crypto.getRandomValues(randomArray);
  randomArray.forEach((number) => {
    result += chars[number % chars.length];
  });
  return result;
}
