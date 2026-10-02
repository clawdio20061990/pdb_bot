export interface User {
  chat_id: number;
  username: string | null;
  name: string | null;
  tg_first_name: string | null;
  language: string;
  likes: string;
  dislikes: string;
  is_active: boolean;
}

export type EventStatus =
  | 'planning'
  | 'choosing_venue'
  | 'confirming'
  | 'drafting'
  | 'reviewing'
  | 'sending'
  | 'sent'
  | 'cancelled'
  | 'failed';

export const OPEN_EVENT_STATUSES: EventStatus[] = ['planning', 'choosing_venue', 'confirming', 'drafting', 'reviewing'];

/**
 * What the organizer asked for, as understood by the model (no Google Maps data in here).
 * English fields feed prompts; *_local fields are shown to the organizer in their language.
 */
export interface Plan {
  activity: string;
  activity_local: string;
  /** 'public' = a real place to look up / suggest, 'private' = someone's home etc., 'none' = no place given. */
  venue_kind: 'public' | 'private' | 'none';
  venue_name: string | null;
  venue_type: string;
  when_text: string | null;
  when_local: string | null;
  /** Other wishes from the organizer's message, in English (e.g. "cheap", "near the Old Town"). */
  notes?: string | null;
}

export interface MapsSource {
  name: string;
  url: string;
  place_id: string | null;
}

/** The one Google Maps answer per event: what the chosen place offers, plus its sources. */
export interface VenueFacts {
  text: string;
  sources: MapsSource[];
}

/**
 * A place offered to the organizer from a Maps-grounded answer. Only the label and the place id are kept
 * (Maps terms: place ids may be stored; grounded content only in the initiating user's context, briefly).
 */
export interface VenueOption {
  name: string;
  place_id: string | null;
}

/** The place the organizer confirmed. maps_url is built by us from the place id (Google Maps URLs API). */
export interface Venue {
  name: string;
  place_id: string | null;
  maps_url: string | null;
}

export interface EventRow {
  id: number;
  organizer_chat_id: number;
  original_text: string;
  status: EventStatus;
  plan: Plan | null;
  venue_options: VenueOption[] | null;
  venue: Venue | null;
  venue_facts: VenueFacts | null;
  send_mode: 'now' | 'review' | null;
  card_message_id: number | null;
  /** The single "review invitations" message (list of people, or one open draft). */
  review_message_id: number | null;
  /** Which draft that message currently shows (null = the list). */
  open_invitation_id: number | null;
  error: string | null;
  created_at: Date;
}

export type InvitationStatus = 'pending' | 'draft' | 'excluded' | 'queued' | 'sending' | 'sent' | 'failed';
export type Rsvp = 'yes' | 'maybe' | 'no';

export interface Invitation {
  id: number;
  event_id: number;
  recipient_chat_id: number;
  language: string;
  status: InvitationStatus;
  base_text: string | null;
  final_text: string | null;
  message_id: number | null;
  rsvp: Rsvp | null;
  rsvp_at: Date | null;
  proposal: string | null;
  attempts: number;
  last_error: string | null;
}

export type PendingKind = 'own_venue' | 'edit_draft' | 'ai_tweak';

export interface PendingInput {
  chat_id: number;
  kind: PendingKind;
  ref_id: number;
  created_at: Date;
}

export function displayName(u: Pick<User, 'name' | 'tg_first_name' | 'username' | 'chat_id'>): string {
  return u.name || u.tg_first_name || u.username || String(u.chat_id);
}

/** Google Maps URLs API link (no key needed); falls back to a text search when there is no place id. */
export function mapsUrl(name: string, placeId: string | null, city: string): string {
  const params = new URLSearchParams({ api: '1', query: `${name}, ${city}` });
  if (placeId) params.set('query_place_id', placeId);
  return `https://www.google.com/maps/search/?${params.toString()}`;
}
