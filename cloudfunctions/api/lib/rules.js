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
  penaltyWindowMin: 60, // 开赛前多少分钟内取消视作缺席
  cancelDeadlineDaysBefore: 1,
  cancelDeadlineTime: '21:00',
}

const FINE_REASONS = {
  late: '迟到',
  no_show: '未到',
  late_cancel: '临时取消',
  no_forward: '缺席未转发',
  manual: '其他',
}

// 取消报名处于哪个阶段：
//   free    缺席截止前，推荐转发
//   warn    缺席截止后，必须转发，不罚款
//   penalty 开赛前 penaltyWindowMin 内，视作缺席，罚款
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

function attendanceFor(checkinAt, game) {
  if (!checkinAt) return 'no_show'
  return checkinAt <= game.cutoffAt ? 'on_time' : 'late'
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
  cancelPhase,
  checkinOpensAt,
  canCheckinAt,
  attendanceFor,
  isLatePromotion,
  haversineM,
  checkinCode,
  verifyCheckinCode,
}
