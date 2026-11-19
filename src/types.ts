export type Source = "web_form" | "missed_call" | "inbound_sms";
export type Channel = "sms" | "email";
export type Stage =
  | "new"            // created, first question sent
  | "qualifying"     // answering questions
  | "qualified"      // scored hot/warm, booking link sent
  | "booked"         // appointment booked
  | "disqualified"   // outside area, renter for install, etc.
  | "nurture"        // cold: just researching
  | "no_response"    // sequence finished without a reply
  | "handoff"        // asked for a human
  | "opted_out";     // replied STOP

export type QuestionKey = "service" | "timeline" | "zip" | "owner";

export interface Answers {
  service?: "install" | "repair" | "maintenance";
  timeline?: "asap" | "month" | "researching";
  zip?: string;
  owner?: boolean;
}

export interface Lead {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  source: Source;
  channel: Channel;
  stage: Stage;
  step: number;                 // index of the next question
  clarifications: number;       // re-asks for the current question
  answers: Answers;
  score: number | null;
  tier: "hot" | "warm" | "cold" | "disqualified" | null;
  crmContactId: string | null;
  crmDealId: string | null;
  bookingAt: string | null;
  lastInboundAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  leadId: string;
  direction: "in" | "out";
  channel: Channel;
  body: string;
  at: string;
}
