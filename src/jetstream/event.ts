// The Jetstream envelope. JSON.parse has already parsed the whole message; "unparsed record"
// means we do not validate or type `record` here. It stays `unknown` until a route narrows it,
// so the hot path never pays for validating fields most routes never read.

export type Kind = "commit" | "identity" | "account";
export type Operation = "create" | "update" | "delete";

export interface Commit {
  operation: Operation;
  collection: string;
  rkey: string;
  rev: string;
  cid?: string; // absent on delete
  record?: unknown; // present on create/update. Never log this.
}

export interface JetstreamEvent {
  did: string;
  timeUs: number; // the resume cursor
  kind: Kind;
  commit?: Commit; // only when kind === "commit"
}

const KINDS = new Set<string>(["commit", "identity", "account"]);
const OPS = new Set<string>(["create", "update", "delete"]);

// Returns undefined for anything that does not look like a Jetstream event. Malformed input
// is counted by the caller, never thrown: one bad frame must not take the socket down.
export function decodeEnvelope(raw: string): JetstreamEvent | undefined {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof json !== "object" || json === null) return undefined;
  const o = json as Record<string, unknown>;
  if (typeof o.did !== "string" || typeof o.time_us !== "number" || typeof o.kind !== "string") return undefined;
  if (!KINDS.has(o.kind)) return undefined;

  const event: JetstreamEvent = { did: o.did, timeUs: o.time_us, kind: o.kind as Kind };

  if (o.kind === "commit") {
    const c = o.commit;
    if (typeof c !== "object" || c === null) return undefined;
    const cc = c as Record<string, unknown>;
    if (typeof cc.operation !== "string" || !OPS.has(cc.operation)) return undefined;
    if (typeof cc.collection !== "string" || typeof cc.rkey !== "string" || typeof cc.rev !== "string") return undefined;
    event.commit = {
      operation: cc.operation as Operation,
      collection: cc.collection,
      rkey: cc.rkey,
      rev: cc.rev,
      cid: typeof cc.cid === "string" ? cc.cid : undefined,
      record: cc.record,
    };
  }
  return event;
}

// at://did/collection/rkey — the stable identifier of a record, safe to log.
export function atUri(event: JetstreamEvent): string | undefined {
  if (!event.commit) return undefined;
  return `at://${event.did}/${event.commit.collection}/${event.commit.rkey}`;
}
