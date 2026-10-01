// 时区工具。所有时间戳都是 UTC 毫秒；比赛自身带一个 IANA 时区（如 America/Los_Angeles），
// 规则里的“前一天 21:00”之类都按比赛时区计算。
const dayjs = require('dayjs')
const utc = require('dayjs/plugin/utc')
const timezone = require('dayjs/plugin/timezone')

dayjs.extend(utc)
dayjs.extend(timezone)

const WEEK = ['日', '一', '二', '三', '四', '五', '六']

function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch (e) {
    return false
  }
}

// date: 'YYYY-MM-DD', time: 'HH:mm'，按 tz 当地时间解释
function zonedToUtcMs(date, time, tz) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    throw new Error(`bad date/time: ${date} ${time}`)
  }
  return dayjs.tz(`${date} ${time}`, tz).valueOf()
}

function zonedParts(ms, tz) {
  const d = dayjs(ms).tz(tz)
  return { date: d.format('YYYY-MM-DD'), time: d.format('HH:mm') }
}

function offsetMin(ms, tz) {
  return dayjs(ms).tz(tz).utcOffset()
}

// 例：9月30日(周三) 14:00
function fmtLocal(ms, tz) {
  const d = dayjs(ms).tz(tz)
  return `${d.month() + 1}月${d.date()}日(周${WEEK[d.day()]}) ${d.format('HH:mm')}`
}

// 例：周日
function weekdayText(ms, tz) {
  return `周${WEEK[dayjs(ms).tz(tz).day()]}`
}

// 例：2026年9月30日 14:00（订阅消息 time/date 字段用）
function fmtPlain(ms, tz) {
  return dayjs(ms).tz(tz).format('YYYY年M月D日 HH:mm')
}

// 纯日期加减，不涉及时区
function shiftDate(date, days) {
  return dayjs(date).add(days, 'day').format('YYYY-MM-DD')
}

// 比赛开始前 daysBefore 天的 time（比赛时区）
function deadlineBefore(startAt, tz, daysBefore, time) {
  const date = dayjs(startAt).tz(tz).subtract(daysBefore, 'day').format('YYYY-MM-DD')
  return zonedToUtcMs(date, time, tz)
}

module.exports = {
  isValidTimeZone,
  zonedToUtcMs,
  zonedParts,
  offsetMin,
  fmtLocal,
  fmtPlain,
  weekdayText,
  shiftDate,
  deadlineBefore,
}
