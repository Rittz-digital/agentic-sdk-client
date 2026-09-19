/**
 * Wire-format types shared with the SDK service (agentic-sdk/src/types.ts). Kept as a plain
 * duplicate rather than a shared package right now — two files small enough to keep in sync by
 * hand beat a build-order dependency between the SDK and its own client for a v0.1 package. If
 * this client ever moves to its own published package, promote this to a real `@hanexis/agentic-sdk-types`
 * dependency both sides import instead.
 */

export type FieldType = "string" | "number" | "boolean" | "date" | "objectId" | "mixed" | "array" | "object";

export type SchemaField = {
  name: string;
  type: FieldType;
  required: boolean;
  indexed: boolean;
  enumValues?: string[];
  items?: SchemaField[];
  properties?: SchemaField[];
  semanticNote?: string;
};

export type CollectionRole = "business-data" | "application-state";

/**
 * `role` and `description` are OPTIONAL — pass only field structure and the SDK infers both with
 * an LLM call the first time it sees this schema (see the SDK service's `schema-inference.ts`),
 * caching the result so it only runs once per raw structure. Supply them yourself when you know
 * them; the SDK never overwrites anything you explicitly stated, only fills what's missing.
 */
export type CollectionSchema = {
  modelName: string;
  collectionName: string;
  role?: CollectionRole;
  fields: SchemaField[];
  undiscoverableFields: SchemaField[];
  looseSchema: boolean;
  description?: string;
};

export type DerivedRelationship = {
  label: string;
  fromCollection: string;
  viaField: string;
  toCollection: string;
  kind: "name-chain" | "id-lookup";
  resolution: string;
};

/** `relationships`/`fieldSemantics` may be omitted too — same "the SDK infers what it can" principle as `CollectionSchema.role`/`description`. */
export type SchemaSourceDescriptor = {
  connectionId: string;
  collections: CollectionSchema[];
  relationships?: DerivedRelationship[];
  fieldSemantics?: Record<string, string>;
};

export type QueryRequest = {
  collection: string;
  kind: "find" | "aggregate" | string;
  query: unknown;
  limit?: number;
  /** `find`-only: how many matching documents to skip — pages past the per-page cap. */
  skip?: number;
  /** `find`-only: field paths to return instead of whole documents — keeps a many-row listing from flooding the context. */
  fields?: string[] | null;
  /** `find`-only: field -> 1 | -1. */
  sort?: unknown;
  /** `find`-only: preferred way to search a name/text field, instead of a hand-written `$regex`. */
  nameSearch?: { term: string; fields: string[] };
};

export type QueryResult = {
  found: boolean;
  returnedCount?: number;
  /** True total matching the filter, vs `returnedCount` for this page — lets the SDK tell a partial page from a complete one. */
  totalMatching?: number;
  documents?: unknown[];
  error?: string;
};

export type TopicScopeRule = { label: string; pattern: string };

export type AgentMessageRole = "user" | "model";
export type AgentTextPart = { kind: "text"; text: string };
export type AgentFunctionCallPart = { kind: "functionCall"; id: string; name: string; args: Record<string, unknown>; providerData?: unknown };
export type AgentFunctionResultPart = { kind: "functionResult"; callId: string; name: string; result: unknown };
export type AgentMessagePart = AgentTextPart | AgentFunctionCallPart | AgentFunctionResultPart;
export type AgentMessage = { role: AgentMessageRole; parts: AgentMessagePart[] };

export type AgentSessionConfig = {
  schema: SchemaSourceDescriptor;
  allowedCollections: string[];
  queryCallbackUrl: string;
  callbackAuthToken: string;
  outOfScopeTopics?: TopicScopeRule[];
  scopeDescription?: string;
  /** How monetary values should be written, e.g. "₹" — see the SDK's own `types.ts` for why this cannot be inferred from the data. */
  currencySymbol?: string;
};

export type TurnStreamEvent =
  | { type: "reasoning"; iteration: number; text: string }
  | { type: "text"; chunk: string }
  | { type: "done"; replyText: string; toolCalls: { name: string; args: unknown; result: unknown }[]; schemaInferenceRan: boolean }
  | { type: "refused"; module: string }
  /** `toolCalls` carries whatever the failed turn DID run before failing — see the SDK's own `types.ts`. */
  | { type: "error"; message: string; toolCalls?: { name: string; args: unknown; result: unknown }[] };

// ---------------------------------------------------------------------------
// Rendered table — what `renderTable` puts in its tool result for a caller's UI to draw.
// Mirrors the SDK's own `table-spec.ts` (kept as a plain duplicate, like the rest of this file,
// so this package stays dependency-free — the SDK validates with zod, the caller re-validates
// however it likes). See that module for why the model references a prior tool result instead of
// retyping rows.
// ---------------------------------------------------------------------------

export type TableColumnFormat = "text" | "number" | "currency" | "percent" | "date";

export type TableColumn = {
  /** Field path in the source documents, e.g. "orderNumber" or "items.productName". */
  field: string;
  /** Human column heading, never a raw field name. */
  label: string;
  format?: TableColumnFormat;
  /** Unit suffix for `number` columns, e.g. "Kg". */
  unit?: string;
};

export type RenderedTable = {
  title: string;
  columns: TableColumn[];
  rows: Record<string, unknown>[];
  caption?: string;
  /** True total behind the rows, when known — lets a UI say "showing 50 of 83". */
  totalMatching?: number;
};
