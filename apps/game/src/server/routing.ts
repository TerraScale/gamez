/** Maps a Cloudflare continent code to a Durable Object location hint. */
export function relayLocation(
  continent: string,
  longitude = Number.NaN,
): DurableObjectLocationHint | undefined {
  switch (continent) {
    case "NA":
      // West of ~100°W is closer to the west-coast region.
      return longitude < -100 ? "wnam" : "enam";
    case "SA":
      return "sam";
    case "EU":
      return "weur";
    case "AF":
      return "afr";
    case "AS":
      return "apac";
    case "OC":
      return "oc";
    default:
      return undefined;
  }
}
