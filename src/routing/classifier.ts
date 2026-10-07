import type { JetstreamEvent } from "../jetstream/event.js";
import type { Route } from "./route.js";

// Returns every route whose predicate matches. An event may fan out to several routes
// (a like delete is both a deletion and an engagement event); an empty result is "unmatched".
export function classify(event: JetstreamEvent, routes: readonly Route[]): Route[] {
  const matched: Route[] = [];
  for (const route of routes) {
    if (route.match(event)) matched.push(route);
  }
  return matched;
}
