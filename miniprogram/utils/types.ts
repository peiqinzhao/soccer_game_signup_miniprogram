// 与云函数返回结构对应

export interface Venue {
  _id: string
  clubId: string
  name: string
  address: string
  lat: number
  lng: number
  radiusM: number
}

export interface ClubSettings {
  timezone: string
  capacity: number
  durationMin: number
  lateGraceMin: number
  fineCents: number
  checkinRadiusM: number
  checkinOpenBeforeMin: number
  penaltyWindowMin: number
  cancelDeadlineDaysBefore: number
  cancelDeadlineTime: string
}

export interface Game {
  _id: string
  clubId: string
  clubName?: string
  title: string
  note: string
  timezone: string
  tzOffsetMin: number
  startAt: number
  endAt: number
  cutoffAt: number
  durationMin: number
  lateGraceMin: number
  capacity: number
  registeredCount: number
  fineCents: number
  cancelDeadlineAt: number
  signupOpensAt: number
  penaltyWindowMin: number
  checkinOpenBeforeMin: number
  status: 'active' | 'cancelled'
  teamSize: number
  teamCount: number
  autoTeams: boolean
  goalkeeper: boolean
  tags?: string[]
  teamsFormedAt?: number
  cancelReason?: string
  cancelledAt?: number
  lastChange?: { at: number; text: string }
  settledAt: number
  venue: { id: string; name: string; address: string; lat: number; lng: number; radiusM: number }
  local: { start: string; end: string; cutoff: string; cancelDeadline: string; signupOpens: string }
  myStatus?: string
  myAttendance?: string
}

export interface RegView {
  openid: string
  name: string
  avatar: string
  isNew: boolean
  inviterName: string
  status: 'registered' | 'waitlist' | 'cancelled'
  signedAt: number
  spotAt: number
  waitlistAt: number
  cancelledAt: number
  cancelPhase: '' | 'free' | 'warn' | 'penalty'
  cancelledFrom?: '' | 'registered' | 'waitlist'
  tags?: string[]
  checkinAt: number
  checkinMethod: string
  attendance: '' | 'on_time' | 'late' | 'no_show'
  subscribedChange: boolean
}

export interface GameFine {
  _id: string
  openid: string
  reasonText: string
  amountCents: number
  status: 'pending' | 'paid' | 'waived'
}

export interface TeamMember {
  openid: string
  name: string
  avatar: string
  gk: number
  late: boolean
}

export interface TeamsView {
  formed: boolean
  threshold: number
  checkedIn: number
  goalkeeper: boolean
  teams: { name: string; members: TeamMember[] }[]
  myTeam: string
  myGk: number
}

export interface GameDetail {
  serverNow: number
  fines: GameFine[]
  teams: TeamsView | null
  game: Game
  club: { _id: string; name: string; venmo: string }
  registered: RegView[]
  waitlist: RegView[]
  cancelled: RegView[]
  me: {
    openid: string
    isMember: boolean
    isAdmin: boolean
    reg: RegView | null
    unpaidCents: number
    checkinOpensAt: number
    openReminder: boolean
  }
}

export interface GameForm {
  title: string
  note: string
  timezone: string
  date: string
  time: string
  durationMin: number
  venueId: string
  capacity: number
  teamSize: number
  teamCount: number
  autoTeams: boolean
  goalkeeper: boolean
  tags: string[]
  lateGraceMin: number
  fineCents: number
  signupOpens: { date: string; time: string } | null
  cancelDeadline: { date: string; time: string } | null
}

export interface MemberView {
  openid: string
  name: string
  role: 'owner' | 'admin' | 'member'
  avatar: string
  inviterName: string
  joinedAt: number
}

export interface ClubDetail {
  club: { _id: string; name: string; venmo: string; settings: ClubSettings; ownerOpenid: string }
  me: { role: string; name: string; isAdmin: boolean; isOwner: boolean }
  members: MemberView[]
  venues: Venue[]
  pendingFines: number
}

export interface Fine {
  _id: string
  clubId: string
  gameId: string
  openid: string
  name: string
  avatar: string
  reason: string
  reasonText: string
  gameText: string
  amountCents: number
  status: 'pending' | 'paid' | 'waived'
  method?: string
  note: string
  createdAt: number
  resolvedAt?: number
}

export interface LedgerEntry {
  _id: string
  type: 'income' | 'expense' | 'opening'
  amountCents: number
  signedCents: number
  note: string
  date: number
  receipt: string
  fineId: string
  payerName: string
  createdByName: string
  voided: boolean
}

export interface GameTemplate {
  id: string
  name: string
  title: string
  note: string
  timezone: string
  weekday: number
  time: string
  durationMin: number
  venueId: string
  capacity: number
  teamSize?: number
  teamCount?: number
  autoTeams?: boolean
  goalkeeper?: boolean
  tags?: string[]
  lateGraceMin: number
  fineCents: number
  signupOpens: { daysBefore: number; time: string } | null
}
