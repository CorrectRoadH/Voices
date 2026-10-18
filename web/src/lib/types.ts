import type { components } from "./api.generated";
export type Schema = components["schemas"];
export type Recording = Schema["Recording"];
export type Transcription = Schema["Transcription"];
export type TranscriptionDetail = Schema["TranscriptionDetail"];
export type Segment = Schema["Segment"];
export type Person = Schema["Person"];
export type ProviderOperation = Schema["ProviderOperation"];
export type Job = Schema["Job"];
export type Provider = Schema["Provider"];
export type Options = Schema["TranscriptionOptions"];
export type Settings = Schema["Settings"];
export type Session = Schema["Session"];
export type Label = Schema["SpeakerLabel"];
export type Page<T> = { items: T[]; next_cursor: string | null };

export type User = Schema["User"];
