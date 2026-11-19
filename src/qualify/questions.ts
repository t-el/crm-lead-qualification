import type { Answers, QuestionKey } from "../types.js";

export interface Question {
  key: QuestionKey;
  text: string;
  clarify: string;
}

export const QUESTIONS: Question[] = [
  { key: "service", text: "What can we help with? Reply 1 for a new install or replacement, 2 for a repair, 3 for a maintenance plan.",
    clarify: "Sorry, I didn't catch that. Is it 1) a new install, 2) a repair, or 3) maintenance?" },
  { key: "timeline", text: "How soon do you need us? 1) ASAP / this week 2) This month 3) Just researching",
    clarify: "No problem. Roughly when: this week, this month, or just looking for now?" },
  { key: "zip", text: "What's the ZIP code of the property?", clarify: "Could you send the 5-digit ZIP code of the property?" },
  { key: "owner", text: "Last one: do you own the property? (yes/no)", clarify: "Just a yes or no: do you own the property?" },
];

export function nextQuestion(answers: Answers): Question | null {
  return QUESTIONS.find((q) => answers[q.key] === undefined) ?? null;
}

export const firstMessage = (business: string, name: string, source: "web_form" | "missed_call" | "inbound_sms") => {
  const hi = name ? `Hi ${name.split(" ")[0]}` : "Hi";
  if (source === "missed_call") return `${hi}, this is ${business}. Sorry we missed your call! I can get you booked by text in under a minute. ${QUESTIONS[0].text}`;
  return `${hi}, thanks for contacting ${business}! A couple of quick questions so we send the right technician. ${QUESTIONS[0].text}`;
};
