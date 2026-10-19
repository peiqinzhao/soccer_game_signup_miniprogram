// 纯规则函数，不碰数据库，方便单测。
const crypto = require('crypto')

const MIN = 60 * 1000

// 球队默认设置；每场比赛创建时拷贝一份，之后改球队设置不影响已发起的比赛。
const DEFAULT_SETTINGS = {
  timezone: 'America/Los_Angeles',
  capacity: 24,
  durationMin: 120,
  lateGraceMin: 10, // 开赛后多少分钟内签到算准时
  fineCents: 500,
  checkinRadiusM: 100,
  checkinOpenBeforeMin: 30,
  penaltyWindowMin: 60, // 开赛前多少分钟内取消算临时取消（罚款）
  cancelDeadlineDaysBefore: 1,
  cancelDeadlineTime: '21:00',
  defaultTags: [], // 新发起比赛时默认带上的标签
  checkinEnabled: true, // 新发起比赛默认开启到场签到
  finesEnabled: true, // 关闭后整个球队不产生任何罚款、不拦截报名
  matchStatsEnabled: false, // 记录进球/助攻（足球等用；网球、羽毛球等可不开）
  // 自评等级：off 不使用；labels 文字档位；numeric 数字等级（如网球 NTRP 1.0–7.0，间隔 0.5）
  rating: { mode: 'off', labels: ['入门', '中级', '高手'], min: 1, max: 7, step: 0.5 },
}

// 比赛自选标签：管理员定义（如“已付款”），队员自己打上或取消
const MAX_TAGS = 3
const MAX_TAG_LEN = 6
function cleanTags(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[,，、\s]+/)
  const tags = []
  for (const raw of list) {
    const t = String(raw || '').trim()
    if (!t || tags.includes(t)) continue
    if (t.length > MAX_TAG_LEN) throw new Error(`标签“${t}”太长，最多 ${MAX_TAG_LEN} 个字`)
    tags.push(t)
  }
  if (tags.length > MAX_TAGS) throw new Error(`最多 ${MAX_TAGS} 个标签`)
  return tags
}

// ---------- 自评等级 ----------
function stepDecimals(step) {
  const t = String(step)
  return t.includes('.') ? t.split('.')[1].length : 0
}

// 校验并整理球队的等级设置；不合法时抛出 Error（调用方转成 UserError）
function cleanRating(input) {
  const r = { ...DEFAULT_SETTINGS.rating, ...(input || {}) }
  if (!['off', 'labels', 'numeric'].includes(r.mode)) throw new Error('等级方式无效')
  const labels = Array.isArray(r.labels) ? r.labels : String(r.labels || '').split(/[,，、\s]+/)
  const cleaned = [...new Set(labels.map((x) => String(x).trim()).filter(Boolean))]
  if (r.mode === 'labels') {
    if (cleaned.length < 2 || cleaned.length > 6) throw new Error('文字档位需要 2–6 个')
    if (cleaned.some((x) => x.length > 6)) throw new Error('每个档位最多 6 个字')
  }
  const min = Number(r.min)
  const max = Number(r.max)
  const step = Number(r.step)
  if (r.mode === 'numeric') {
    if (![min, max, step].every(Number.isFinite) || step <= 0 || min >= max) throw new Error('数字等级的范围或间隔无效')
    if ((max - min) / step > 100) throw new Error('数字等级的档位太多（最多 100 档）')
  }
  return { mode: r.mode, labels: cleaned.length ? cleaned : DEFAULT_SETTINGS.rating.labels, min, max, step }
}

// 按球队设置列出所有可选等级（显示用字符串）
function levelOptions(rating) {
  if (!rating || rating.mode === 'off') return []
  if (rating.mode === 'labels') return rating.labels
  const d = stepDecimals(rating.step)
  const out = []
  for (let i = 0; rating.min + i * rating.step <= rating.max + 1e-9; i++) out.push((rating.min + i * rating.step).toFixed(d))
  return out
}

// 当前设置下这个等级还有效就返回它，否则返回 ''（球队改了等级方式后旧值不再显示）
function validLevel(rating, level) {
  return level && levelOptions(rating).includes(level) ? level : ''
}

const FINE_REASONS = {
  late: '迟到',
  no_show: '未到',
  late_cancel: '临时取消',
  no_forward: '取消未转发',
  manual: '其他',
}

// 取消报名处于哪个阶段：
//   free    截止前取消，推荐转发
//   warn    截止后取消，必须转发，不罚款
//   penalty 开赛前 penaltyWindowMin 内取消，算临时取消，罚款
function cancelPhase(game, now) {
  if (now < game.cancelDeadlineAt) return 'free'
  if (now < game.startAt - game.penaltyWindowMin * MIN) return 'warn'
  return 'penalty'
}

function checkinOpensAt(game) {
  return game.startAt - game.checkinOpenBeforeMin * MIN
}

// 允许签到到比赛结束（截止之后签到记为迟到）
function canCheckinAt(game, now) {
  return now >= checkinOpensAt(game) && now <= game.endAt
}

// 迟到从“开赛 + 宽限”这一刻起算：宽限 10 分钟，10:09:59 算准时，10:10:00 起算迟到。
// 按 startAt 和 lateGraceMin 现算，不依赖存下来的 cutoffAt。
function lateAt(game) {
  return game.startAt + game.lateGraceMin * MIN
}

function attendanceFor(checkinAt, game) {
  if (!checkinAt) return 'no_show'
  return checkinAt < lateAt(game) ? 'on_time' : 'late'
}

// 在开赛前 penaltyWindowMin 内才递补上的人，可能来不及看到通知，不自动罚款
function isLatePromotion(reg, game) {
  return !!reg.promotedAt && reg.promotedAt >= game.startAt - game.penaltyWindowMin * MIN
}

function haversineM(a, b) {
  const R = 6371000
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

// 现场签到码：每分钟变化的 4 位数字。校验时接受当前和上一分钟的码。
function checkinCode(secret, gameId, now) {
  const bucket = Math.floor(now / MIN)
  return codeForBucket(secret, gameId, bucket)
}

function codeForBucket(secret, gameId, bucket) {
  const h = crypto.createHmac('sha256', secret).update(`${gameId}:${bucket}`).digest()
  return String(h.readUInt32BE(0) % 10000).padStart(4, '0')
}

function verifyCheckinCode(secret, gameId, code, now) {
  const bucket = Math.floor(now / MIN)
  return [bucket, bucket - 1].some((b) => codeForBucket(secret, gameId, b) === String(code))
}

module.exports = {
  MIN,
  DEFAULT_SETTINGS,
  FINE_REASONS,
  cleanTags,
  cleanRating,
  levelOptions,
  validLevel,
  cancelPhase,
  checkinOpensAt,
  canCheckinAt,
  lateAt,
  attendanceFor,
  isLatePromotion,
  haversineM,
  checkinCode,
  verifyCheckinCode,
}
