// ClickHouse is retired on the GreptimeDB backend. These two helpers are not
// ClickHouse clients — they are pure utilities that several converters and the
// shared SQL filter factory still depend on (a CH-flavoured date parse and a
// SQL-safe random identifier). Kept here until the TIER2 rename (issue #7).

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
