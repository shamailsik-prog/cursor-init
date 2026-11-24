import type { Classification } from "@/platform/p1/types"

/** A prospective client. `type` stays null when the name does not say which it is. */
export const CLIENT_TYPES = ["individual", "company", "government"] as const
export type ClientType = (typeof CLIENT_TYPES)[number]

export const INTAKE_STATUSES = ["open", "follow_up", "routed", "closed", "promoted"] as const
export type IntakeStatus = (typeof INTAKE_STATUSES)[number]

export const URGENCIES = ["routine", "urgent", "immediate"] as const
export type Urgency = (typeof URGENCIES)[number]

export type FollowUpReason = "ambiguous_court_prefix" | "unknown_court_prefix" | "ambiguous_entity"

export type OpposingParty = { name: string; cnic?: string }

export type Prospect = {
  name: string
  phone: string | null
  email: string | null
  type: ClientType | null
  opposingParties: OpposingParty[]
}

/** A court reference judged only against the seeded prefix table. */
export type CourtView = {
  raw: string
  courtId: string
  status: "ok" | "ambiguous" | "rejected"
  prefix?: string
  canonical?: string
}

export type WaiverRef = {
  checkId: string
  partnerId: string
  consentReference: string
  note: string
  at: string
}

export type IntakeRecord = {
  intakeId: string
  firmId: string
  classification: Classification
  matterId: string | null
  clientId: string | null
  conflictCheckId: string | null
  status: IntakeStatus
  practiceArea: string | null
  urgency: Urgency
  followUp: boolean
  followUpReasons: FollowUpReason[]
  assigneeId: string | null
  queue: "lawyer" | "follow_up" | null
  text: string
  prospect: Prospect
  court: CourtView | null
  waiver: WaiverRef | null
  confirmedBy: string | null
  closeReason: string | null
  createdBy: string
  createdAt: string | null
}

export type IntakeMessage = {
  messageId: string
  intakeId: string
  firmId: string
  direction: "inbound"
  text: string
  createdAt: string | null
}

export type CreateIntakeInput = {
  text: string
  prospect: {
    name: string
    phone?: string
    email?: string
    type?: ClientType
    opposingParties?: OpposingParty[]
  }
  courtRef?: { raw: string; courtId: string }
  classification?: Classification
}

export type RouteRule = { practiceArea: string; assigneeId: string }

export type PromoteResult = {
  intakeId: string
  clientId: string
  matterId: string
  conflictCheckId: string
  waiver: WaiverRef | null
}

export type ClassifyInput = {
  text: string
  prospectName: string
  prospectType: ClientType | null
  courtRef?: { raw: string; courtId: string }
}

export type ClassifyOutput = {
  practiceArea: string | null
  urgency: Urgency
  followUp: boolean
  followUpReasons: FollowUpReason[]
  prospectType: ClientType | null
  court: CourtView | null
}

/** The P1 classifier will implement this. Tests pass a deterministic stub. */
export interface IntakeClassifier {
  classify(input: ClassifyInput): ClassifyOutput
}
