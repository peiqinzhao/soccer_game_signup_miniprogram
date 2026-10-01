const WEEK = ['日', '一', '二', '三', '四', '五', '六']
const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`)

// 按设备当前时区显示
export function fmtDateTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getMonth() + 1}月${d.getDate()}日(周${WEEK[d.getDay()]}) ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fmtTime(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fmtShort(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fmtDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function money(cents: number): string {
  const v = cents / 100
  const s = Number.isInteger(v) ? `${Math.abs(v)}` : Math.abs(v).toFixed(2)
  return `${cents < 0 ? '-' : ''}$${s}`
}

// 设备时区在该时刻相对 UTC 的偏移（分钟，东正西负）
export function deviceOffsetMin(ms: number): number {
  return -new Date(ms).getTimezoneOffset()
}

export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  } catch (e) {
    return ''
  }
}

export const TIMEZONES = [
  { id: 'America/Los_Angeles', label: '美国太平洋 (Los Angeles)' },
  { id: 'America/Denver', label: '美国山地 (Denver)' },
  { id: 'America/Phoenix', label: '美国亚利桑那 (Phoenix)' },
  { id: 'America/Chicago', label: '美国中部 (Chicago)' },
  { id: 'America/New_York', label: '美国东部 (New York)' },
  { id: 'Pacific/Honolulu', label: '夏威夷 (Honolulu)' },
  { id: 'America/Vancouver', label: '加拿大太平洋 (Vancouver)' },
  { id: 'America/Toronto', label: '加拿大东部 (Toronto)' },
  { id: 'Europe/London', label: '英国 (London)' },
  { id: 'Europe/Berlin', label: '中欧 (Berlin)' },
  { id: 'Asia/Shanghai', label: '中国 (Shanghai)' },
  { id: 'Asia/Tokyo', label: '日本 (Tokyo)' },
  { id: 'Asia/Singapore', label: '新加坡 (Singapore)' },
  { id: 'Australia/Sydney', label: '澳大利亚东部 (Sydney)' },
]

export function tzLabel(id: string): string {
  const t = TIMEZONES.find((x) => x.id === id)
  return t ? t.label : id
}

export const ATTENDANCE_TEXT: Record<string, string> = {
  on_time: '准时',
  late: '迟到',
  no_show: '未到',
}

export function gameTimeText(g: { startAt: number; endAt: number; tzOffsetMin: number; local: { start: string; end: string } }) {
  return {
    timeText: `${fmtDateTime(g.startAt)}–${fmtTime(g.endAt)}`,
    // 设备时区与比赛时区不同时，额外显示比赛当地时间
    localText: deviceOffsetMin(g.startAt) === g.tzOffsetMin ? '' : `当地时间 ${g.local.start}–${g.local.end}`,
  }
}

// 8, 3 -> '8v8v8'
export function formatText(teamSize: number, teamCount: number): string {
  return new Array(teamCount).fill(teamSize).join('v')
}

// 自动分队规则说明（与云函数 teams.js 的规则一致）
export function teamsRuleText(teamSize: number, teamCount: number): string {
  if (teamCount >= 3) {
    const first = teamCount - 1
    return `签到满 ${first * teamSize} 人时随机分成 ${first} 队，之后签到的人依次进第 ${teamCount} 队；再多的人补到人最少的队。`
  }
  return `签到满 ${teamCount * teamSize} 人时随机分成 ${teamCount} 队；再多的人补到人最少的队。`
}
