export function newId(): string {
  return crypto.randomUUID();
}

/** First segment of a uuid — enough to eyeball, short enough to fit a tile. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
